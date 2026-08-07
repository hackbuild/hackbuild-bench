/**
 * HackRF One over WebUSB.
 *
 * Vendor request numbers, the transceiver mode values and the board id table
 * follow libhackrf hackrf.h. Samples are interleaved signed 8 bit on bulk
 * endpoint 1 for receive and bulk endpoint 2 for transmit.
 *
 * The device opens with the amplifier off, the transmit gain at zero and the
 * transceiver in OFF, so nothing radiates until a mode is started.
 */

import type { Capability } from '@/core/capabilities'
import { CAPABILITIES } from '@/core/capabilities'
import type {
  DeviceDriver,
  DeviceHandle,
  DeviceSession,
  DriverContext,
  StartMode,
  TransmitFrameOptions,
  TransmitSession,
  TxParams,
} from '@/core/drivers/types'
import type { DemodMode } from '@/core/dsp/demod'
import { ReceiveChain } from '@/core/dsp/demod'
import { SpectrumAnalyzer } from '@/core/dsp/fft'
import { afskModulate, bytesToBits, ookFrame, resampleIq } from '@/core/dsp/modulate'
import { UsbPort } from '@/core/transport/webusb'
import type {
  Artifact,
  AudioChunk,
  DeviceDescriptor,
  FftFrame,
  IqChunk,
  TransportKind,
} from '@/core/types'

type Emitted<T extends Artifact> = Omit<T, 'source' | 'seq' | 't' | 'wall'>

const REQ = {
  SET_TRANSCEIVER_MODE: 1,
  SAMPLE_RATE_SET: 6,
  BASEBAND_FILTER_BANDWIDTH_SET: 7,
  BOARD_ID_READ: 14,
  /** VERSION_STRING_READ, BOARD_PARTID_SERIALNO_READ and SET_TXVGA_GAIN
   *  come from libhackrf hackrf.h, they are not in the reference app. */
  VERSION_STRING_READ: 15,
  SET_FREQ: 16,
  AMP_ENABLE: 17,
  BOARD_PARTID_SERIALNO_READ: 18,
  SET_LNA_GAIN: 19,
  SET_VGA_GAIN: 20,
  SET_TXVGA_GAIN: 21,
} as const

/** transceiver_mode_t in hackrf.h. */
const MODE = { OFF: 0, RECEIVE: 1, TRANSMIT: 2 } as const

const BOARD_NAMES: Record<number, string> = {
  0: 'jellybean',
  1: 'jawbreaker',
  2: 'hackrf one',
  3: 'rad1o',
}

const EP_RX = 1
const EP_TX = 2
/** 32768 complex samples per transfer, deep enough to hold 20 Msps. */
const TRANSFER_BYTES = 65536
const TRANSFER_DEPTH = 8
/** Transmit transfers in flight. Fewer than this and the dac runs dry. */
const TX_DEPTH = 4
/** Queue ceiling. About a tenth of a second at 2 Msps, which bounds latency. */
const TX_QUEUE_BYTES = TRANSFER_BYTES * 8
/** A frame longer than this is refused rather than held in memory. */
const TX_FRAME_LIMIT_SECONDS = 10
const FFT_SIZE = 2048
/** Publish spectrum at 20 fps whatever the sample rate feeds in. */
const FFT_INTERVAL_MS = 50
const AUDIO_RATE = 48000

const USB_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x1d50, productId: 0x6089 },
  { vendorId: 0x1d50, productId: 0x604b },
  { vendorId: 0x1d50, productId: 0xcc15 },
]

const DEMODS: DemodMode[] = ['fm', 'nfm', 'am', 'usb', 'lsb']

export const hackrfDescriptor: DeviceDescriptor = {
  kind: 'hackrf',
  name: 'HackRF One',
  blurb: 'wideband, one MHz to six GHz',
  icon: 'satellite-dish',
  transports: ['webusb'],
  capabilities: [
    CAPABILITIES.OBSERVE_SPECTRUM,
    CAPABILITIES.CAPTURE_IQ,
    CAPABILITIES.AUDIO_DEMOD,
    CAPABILITIES.TRANSMIT_RF,
  ],
  params: [
    {
      key: 'centerHz',
      label: 'center',
      unit: 'Hz',
      min: 1e6,
      max: 6000e6,
      default: 433.92e6,
      log: true,
    },
    {
      key: 'sampleRate',
      label: 'sample rate',
      unit: 'Sps',
      min: 2000000,
      max: 20000000,
      default: 10000000,
      choices: [2000000, 8000000, 10000000, 20000000],
    },
    { key: 'lna', label: 'lna', unit: 'dB', min: 0, max: 40, step: 8, default: 24 },
    { key: 'vga', label: 'vga', unit: 'dB', min: 0, max: 62, step: 2, default: 20 },
    { key: 'txvga', label: 'tx gain', unit: 'dB', min: 0, max: 47, step: 1, default: 0 },
    { key: 'amp', label: 'front end amp', min: 0, max: 1, step: 1, default: 0 },
  ],
  usbFilters: USB_FILTERS,
  limits: {
    [CAPABILITIES.TRANSMIT_RF]:
      'transmit puts baseband on the air at the tuned frequency, and receive stops while it runs. arm rf transmit first, and attach an antenna or a dummy load so the output is not driving an open port.',
  },
}

export const hackrfStartModes: StartMode[] = [
  { id: 'rx', label: 'iq stream', requires: CAPABILITIES.CAPTURE_IQ },
  { id: 'audio:nfm', label: 'listen narrow fm', requires: CAPABILITIES.AUDIO_DEMOD },
  { id: 'audio:fm', label: 'listen wide fm', requires: CAPABILITIES.AUDIO_DEMOD },
  { id: 'audio:am', label: 'listen am', requires: CAPABILITIES.AUDIO_DEMOD },
  { id: 'tx', label: 'carrier out', requires: CAPABILITIES.TRANSMIT_RF },
]

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * The hackrf session as a panel sees it. Beyond the adapter contract it takes
 * baseband to put on the air, which is what the transmit studio drives.
 */
export interface HackRfSession extends TransmitSession {
  /** The rate the transmit path runs at, which is the radio's sample rate. */
  txSampleRate(): number
}

class HackRfOneSession implements HackRfSession {
  private usb: UsbPort
  private ctx: DriverContext
  private params: Record<string, number> = {
    centerHz: 433.92e6,
    sampleRate: 10000000,
    lna: 24,
    vga: 20,
    txvga: 0,
    amp: 0,
  }
  private applied: Record<string, number> = {}
  private info: Record<string, string> = {}
  private analyzer = new SpectrumAnalyzer(FFT_SIZE)
  private chain = new ReceiveChain(AUDIO_RATE)
  private abort: AbortController | null = null
  private lastFftAt = 0

  private txActive = false
  private txAbort: AbortController | null = null
  private txPump: Promise<void> | null = null
  private txChunks: Array<Int8Array<ArrayBuffer>> = []
  private txQueued = 0
  private txRoom: Array<() => void> = []
  private txIdle: Array<() => void> = []

  constructor(usb: UsbPort, ctx: DriverContext) {
    this.usb = usb
    this.ctx = ctx
  }

  // -------------------------------------------------------------------------
  // vendor requests
  // -------------------------------------------------------------------------

  private async setFreq(hz: number): Promise<void> {
    const mhz = Math.floor(hz / 1e6)
    const rem = Math.floor(hz - mhz * 1e6)
    const b = new ArrayBuffer(8)
    const dv = new DataView(b)
    dv.setUint32(0, mhz, true)
    dv.setUint32(4, rem, true)
    await this.usb.controlOut(REQ.SET_FREQ, 0, 0, b)
  }

  private async setSampleRate(sps: number): Promise<void> {
    const b = new ArrayBuffer(8)
    const dv = new DataView(b)
    dv.setUint32(0, Math.floor(sps), true)
    // second word is the divider, the rate is set as a fraction.
    dv.setUint32(4, 1, true)
    await this.usb.controlOut(REQ.SAMPLE_RATE_SET, 0, 0, b)
    const bw = Math.floor(0.75 * sps)
    await this.usb.controlOut(
      REQ.BASEBAND_FILTER_BANDWIDTH_SET,
      bw & 0xffff,
      (bw >>> 16) & 0xffff,
    )
  }

  private async setAmp(on: boolean): Promise<void> {
    await this.usb.controlOut(REQ.AMP_ENABLE, on ? 1 : 0, 0)
  }

  /** Gain requests answer with one status byte, so they read rather than write. */
  private async setLna(db: number): Promise<void> {
    const g = clamp(Math.round(db), 0, 40) & ~0x07
    await this.usb.controlIn(REQ.SET_LNA_GAIN, 0, g, 1)
  }

  private async setVga(db: number): Promise<void> {
    const g = clamp(Math.round(db), 0, 62) & ~0x01
    await this.usb.controlIn(REQ.SET_VGA_GAIN, 0, g, 1)
  }

  private async setTxVga(db: number): Promise<void> {
    const g = clamp(Math.round(db), 0, 47)
    await this.usb.controlIn(REQ.SET_TXVGA_GAIN, 0, g, 1)
  }

  private async setTransceiverMode(mode: number): Promise<void> {
    await this.usb.controlOut(REQ.SET_TRANSCEIVER_MODE, mode, 0)
  }

  async init(): Promise<void> {
    try {
      const d = await this.usb.controlIn(REQ.BOARD_ID_READ, 0, 0, 1)
      const id = d.getUint8(0)
      this.info.board = BOARD_NAMES[id] ?? `board ${id}`
    } catch {
      this.info.board = 'unknown'
    }

    try {
      const d = await this.usb.controlIn(REQ.VERSION_STRING_READ, 0, 0, 255)
      const raw = new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
      this.info.firmware = new TextDecoder().decode(raw).replace(/\0+$/, '')
    } catch {
      // an old firmware may not carry a version string.
    }

    try {
      // 6 words: part id [2] then serial number [4], all little endian.
      const d = await this.usb.controlIn(REQ.BOARD_PARTID_SERIALNO_READ, 0, 0, 24)
      if (d.byteLength >= 24) {
        const words: string[] = []
        for (let i = 8; i < 24; i += 4) {
          words.push(d.getUint32(i, true).toString(16).padStart(8, '0'))
        }
        this.info.serial = words.join('')
        this.info.part = `${d.getUint32(0, true).toString(16)}${d.getUint32(4, true).toString(16)}`
      }
    } catch {
      // serial is informational only.
    }

    await this.setTransceiverMode(MODE.OFF)
    await this.setAmp(false)
    await this.setTxVga(0)
    await this.applyRadio(true)
    this.ctx.setInfo(this.info)
  }

  /** Push parameters the hardware has not seen yet. */
  private async applyRadio(force: boolean): Promise<void> {
    const p = this.params
    if (force || p.sampleRate !== this.applied.sampleRate) {
      await this.setSampleRate(p.sampleRate)
      this.applied.sampleRate = p.sampleRate
    }
    if (force || p.centerHz !== this.applied.centerHz) {
      await this.setFreq(p.centerHz)
      this.applied.centerHz = p.centerHz
    }
    if (force || p.lna !== this.applied.lna) {
      await this.setLna(p.lna)
      this.applied.lna = p.lna
    }
    if (force || p.vga !== this.applied.vga) {
      await this.setVga(p.vga)
      this.applied.vga = p.vga
    }
    if (force || p.amp !== this.applied.amp) {
      await this.setAmp(p.amp >= 1)
      this.applied.amp = p.amp
    }
  }

  // -------------------------------------------------------------------------
  // session contract
  // -------------------------------------------------------------------------

  getCapabilities(): Capability[] {
    return [
      CAPABILITIES.OBSERVE_SPECTRUM,
      CAPABILITIES.CAPTURE_IQ,
      CAPABILITIES.AUDIO_DEMOD,
      CAPABILITIES.TRANSMIT_RF,
    ]
  }

  getInfo(): Record<string, string> {
    return { ...this.info }
  }

  async configure(params: Record<string, number>): Promise<void> {
    this.params = { ...this.params, ...params }
    await this.applyRadio(false)
    // transmit gain only reaches the hardware once transmit is armed and running.
    if (this.abort && this.params.txvga !== this.applied.txvga) {
      if (this.ctx.isArmed(CAPABILITIES.TRANSMIT_RF)) {
        await this.setTxVga(this.params.txvga)
        this.applied.txvga = this.params.txvga
      }
    }
  }

  async start(mode: string): Promise<void> {
    await this.stop()
    const [head, tail] = mode.split(':')

    if (head === 'tx') {
      await this.beginTransmit()
      this.ctx.log(
        `carrier out at ${(this.params.centerHz / 1e6).toFixed(3)} MHz, tx gain ${Math.round(this.params.txvga)} dB`,
      )
      void this.carrierLoop()
      return
    }

    await this.applyRadio(false)
    const abort = new AbortController()
    this.abort = abort

    if (head === 'rx') {
      await this.setTransceiverMode(MODE.RECEIVE)
      void this.receive(abort.signal, null)
      return
    }

    if (head === 'audio') {
      const demod = (tail ?? 'nfm') as DemodMode
      if (!DEMODS.includes(demod)) {
        this.abort = null
        throw new Error(`no demodulator called ${demod}. use fm, nfm, am, usb, or lsb.`)
      }
      this.chain.configure(demod, this.params.sampleRate)
      await this.setTransceiverMode(MODE.RECEIVE)
      void this.receive(abort.signal, demod)
      return
    }

    this.abort = null
    throw new Error(`hackrf has no mode called ${mode}`)
  }

  async stop(): Promise<void> {
    if (this.txActive) await this.endTransmit()
    if (!this.abort) return
    this.abort.abort()
    this.abort = null
    try {
      await this.setTransceiverMode(MODE.OFF)
    } catch {
      // the device may already be unplugged, the loops exit either way.
    }
  }

  async resetToSafeState(): Promise<void> {
    await this.stop()
    try {
      await this.setAmp(false)
      await this.setTxVga(0)
      await this.setTransceiverMode(MODE.OFF)
      this.applied.amp = 0
      this.applied.txvga = 0
      this.params.amp = 0
      this.params.txvga = 0
    } catch {
      // nothing left to quiet down when the device is gone.
    }
  }

  async close(): Promise<void> {
    await this.resetToSafeState()
    await this.usb.release()
  }

  async health(): Promise<boolean> {
    if (!this.usb.isOpen) return false
    if (this.abort) return true
    try {
      await this.usb.controlIn(REQ.BOARD_ID_READ, 0, 0, 1)
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // streaming
  // -------------------------------------------------------------------------

  private async receive(signal: AbortSignal, demod: DemodMode | null): Promise<void> {
    await this.usb.stream(
      EP_RX,
      TRANSFER_BYTES,
      TRANSFER_DEPTH,
      (chunk) => this.onSamples(chunk, demod),
      signal,
    )
  }

  private onSamples(chunk: Uint8Array, demod: DemodMode | null): void {
    const s = new Int8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const iq = new Float32Array(s.length)
    // full scale on the ADC is 127 counts per axis.
    for (let i = 0; i < s.length; i++) iq[i] = s[i] / 127

    const centerHz = this.params.centerHz
    const sampleRate = this.params.sampleRate

    if (demod === null) {
      const chunkOut: Emitted<IqChunk> = {
        kind: 'iq',
        samples: iq,
        centerHz,
        sampleRate,
        dropped: 0,
      }
      this.ctx.emit(chunkOut)
    } else {
      const audio = this.chain.process(iq)
      if (audio.length) {
        const chunkOut: Emitted<AudioChunk> = {
          kind: 'audio',
          samples: audio,
          sampleRate: AUDIO_RATE,
        }
        this.ctx.emit(chunkOut)
      }
    }

    const now = performance.now()
    if (now - this.lastFftAt < FFT_INTERVAL_MS) return
    if (iq.length < FFT_SIZE * 2) return
    this.lastFftAt = now
    const frame: Emitted<FftFrame> = {
      kind: 'fft',
      bins: this.analyzer.process(iq).slice(),
      centerHz,
      sampleRate,
    }
    this.ctx.emit(frame)
  }

  // -------------------------------------------------------------------------
  // transmit
  // -------------------------------------------------------------------------

  txSampleRate(): number {
    return this.params.sampleRate
  }

  isTransmitting(): boolean {
    return this.txActive
  }

  private requireTxArm(): void {
    if (this.ctx.isArmed(CAPABILITIES.TRANSMIT_RF)) return
    throw new Error(
      'transmit is not armed. arm rf transmit on this device, check the band is one you may transmit on, and attach an antenna or a dummy load before sending.',
    )
  }

  async setTxParams(params: TxParams): Promise<void> {
    this.requireTxArm()
    const next: Record<string, number> = {}
    if (params.centerHz !== undefined) next.centerHz = clamp(params.centerHz, 1e6, 6000e6)
    if (params.sampleRate !== undefined) {
      next.sampleRate = clamp(params.sampleRate, 2000000, 20000000)
    }
    if (params.txvga !== undefined) next.txvga = clamp(params.txvga, 0, 47)
    if (params.amp !== undefined) next.amp = params.amp >= 1 ? 1 : 0
    this.params = { ...this.params, ...next }
    await this.applyRadio(false)
    if (next.txvga !== undefined) {
      await this.setTxVga(this.params.txvga)
      this.applied.txvga = this.params.txvga
    }
  }

  /**
   * Enter transmit. The radio is half duplex, so receive stops first and the
   * spectrum and audio panels go quiet until endTransmit.
   */
  async beginTransmit(): Promise<void> {
    this.requireTxArm()
    if (this.txActive) return
    await this.stop()
    await this.applyRadio(false)
    await this.setTxVga(this.params.txvga)
    this.applied.txvga = this.params.txvga

    const abort = new AbortController()
    this.txAbort = abort
    this.abort = abort
    this.txActive = true
    this.txChunks = []
    this.txQueued = 0
    await this.setTransceiverMode(MODE.TRANSMIT)
    this.txPump = this.pumpTx(abort.signal)
  }

  async endTransmit(): Promise<void> {
    if (!this.txActive) return
    this.txActive = false
    this.txChunks = []
    this.txQueued = 0
    this.wake(this.txRoom)
    this.wake(this.txIdle)

    const abort = this.txAbort
    this.txAbort = null
    abort?.abort()
    if (this.abort === abort) this.abort = null

    const pump = this.txPump
    this.txPump = null
    if (pump) await pump

    try {
      await this.setTransceiverMode(MODE.OFF)
      // the amplifier goes off between transmissions. a send turns it back on.
      await this.setAmp(false)
      this.applied.amp = 0
      this.params.amp = 0
    } catch {
      // nothing left to quiet down when the device is gone.
    }
  }

  async transmitIq(samples: Float32Array, sampleRate: number): Promise<void> {
    this.requireTxArm()
    if (samples.length < 2) return

    const opened = !this.txActive
    if (opened) {
      await this.beginTransmit()
      const seconds = samples.length / 2 / Math.max(1, sampleRate)
      this.ctx.log(
        `${seconds.toFixed(2)} s of baseband out at ${(this.params.centerHz / 1e6).toFixed(3)} MHz, tx gain ${Math.round(this.params.txvga)} dB`,
      )
    }

    const rate = this.params.sampleRate
    const iq = sampleRate === rate ? samples : resampleIq(samples, sampleRate, rate)
    await this.queue(this.toInt8(iq))

    if (opened) {
      await this.drainTx()
      await this.endTransmit()
    }
  }

  async transmitFrame(bytes: Uint8Array, opts: TransmitFrameOptions = {}): Promise<void> {
    this.requireTxArm()
    if (bytes.length === 0) throw new Error('the frame is empty, there is nothing to send.')

    const rate = this.params.sampleRate
    const keying = opts.mode ?? 'ook'
    const bitRate = clamp(Math.round(opts.bitRate ?? 2000), 50, 200000)
    const seconds = (bytes.length * 8 + 32) / bitRate
    if (seconds > TX_FRAME_LIMIT_SECONDS) {
      throw new Error(
        `that frame runs ${seconds.toFixed(1)} s at ${bitRate} bits per second, past the ${TX_FRAME_LIMIT_SECONDS} s ceiling. shorten it or raise the rate.`,
      )
    }

    const iq =
      keying === 'afsk'
        ? afskModulate(bytes, rate, { baud: bitRate })
        : ookFrame(bytesToBits(bytes), bitRate, rate)

    this.ctx.log(
      `frame out: ${bytes.length} bytes as ${keying} at ${bitRate} ${keying === 'afsk' ? 'baud' : 'bits per second'} on ${(this.params.centerHz / 1e6).toFixed(3)} MHz`,
    )
    await this.transmitIq(iq, rate)
  }

  /** Interleaved floats to the signed 8 bit pairs the transmit endpoint takes. */
  private toInt8(iq: Float32Array): Int8Array<ArrayBuffer> {
    const out = new Int8Array(iq.length)
    for (let i = 0; i < iq.length; i++) {
      const v = Math.round(iq[i] * 127)
      out[i] = v > 127 ? 127 : v < -127 ? -127 : v
    }
    return out
  }

  /** Split into transfer sized pieces and wait when the queue is full. */
  private async queue(buf: Int8Array<ArrayBuffer>): Promise<void> {
    for (let off = 0; off < buf.length; off += TRANSFER_BYTES) {
      while (this.txActive && this.txQueued >= TX_QUEUE_BYTES) {
        await new Promise<void>((resolve) => this.txRoom.push(resolve))
      }
      if (!this.txActive) return
      const piece = buf.subarray(off, Math.min(off + TRANSFER_BYTES, buf.length))
      this.txChunks.push(piece)
      this.txQueued += piece.length
    }
  }

  private async drainTx(): Promise<void> {
    while (this.txActive && this.txQueued > 0) {
      await new Promise<void>((resolve) => this.txIdle.push(resolve))
    }
  }

  private wake(waiters: Array<() => void>): void {
    const pending = waiters.splice(0, waiters.length)
    for (const resolve of pending) resolve()
  }

  /**
   * Keeps several transfers in flight so the dac never runs dry. WebUSB keeps
   * writes on one endpoint in order, so issuing without awaiting is safe.
   * An empty queue sends silence rather than repeating the last buffer.
   */
  private async pumpTx(signal: AbortSignal): Promise<void> {
    const silence = new Int8Array(TRANSFER_BYTES)
    const pending = new Set<Promise<void>>()
    let faults = 0

    const send = async (buf: Int8Array<ArrayBuffer>): Promise<void> => {
      try {
        await this.usb.bulkOut(EP_TX, buf)
        faults = 0
      } catch {
        faults++
      }
    }

    while (!signal.aborted && this.usb.isOpen && faults < 8) {
      while (pending.size >= TX_DEPTH) await Promise.race(pending)
      if (signal.aborted || !this.usb.isOpen) break

      const chunk = this.txChunks.shift()
      if (chunk) {
        this.txQueued -= chunk.length
        this.wake(this.txRoom)
        if (this.txQueued === 0) this.wake(this.txIdle)
      }

      const p = send(chunk ?? silence)
      pending.add(p)
      void p.finally(() => pending.delete(p))
    }

    await Promise.allSettled([...pending])
  }

  /**
   * A constant baseband offset comes out as an unmodulated carrier at the
   * tuned frequency. Amplitude sits below full scale so the DAC does not clip.
   */
  private async carrierLoop(): Promise<void> {
    const block = new Int8Array(TRANSFER_BYTES)
    for (let i = 0; i < block.length; i += 2) {
      block[i] = 96
      block[i + 1] = 0
    }
    while (this.txActive) {
      await this.queue(block)
    }
  }
}

function handleFor(port: UsbPort): DeviceHandle {
  return {
    kind: 'hackrf',
    transport: 'webusb',
    uid: port.serial || port.productName,
    label: 'HackRF One',
    raw: port,
  }
}

export const hackrfDriver: DeviceDriver = {
  descriptor: hackrfDescriptor,

  availableTransports(): TransportKind[] {
    return 'usb' in navigator ? ['webusb'] : []
  },

  async requestAccess(transport: TransportKind): Promise<DeviceHandle | null> {
    if (transport !== 'webusb') throw new Error('the hackrf one only speaks webusb')
    try {
      const port = await UsbPort.request(USB_FILTERS)
      return handleFor(port)
    } catch {
      return null
    }
  },

  async enumerate(): Promise<DeviceHandle[]> {
    const ports = await UsbPort.paired(USB_FILTERS)
    return ports.map(handleFor)
  },

  async open(handle: DeviceHandle, ctx: DriverContext): Promise<DeviceSession> {
    const port = handle.raw as UsbPort
    await port.claim({ interface: 0 })
    const session = new HackRfOneSession(port, ctx)
    await session.init()
    return session
  },
}

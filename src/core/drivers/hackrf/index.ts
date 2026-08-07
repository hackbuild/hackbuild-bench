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
} from '@/core/drivers/types'
import type { DemodMode } from '@/core/dsp/demod'
import { ReceiveChain } from '@/core/dsp/demod'
import { SpectrumAnalyzer } from '@/core/dsp/fft'
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
      'transmit is a carrier at the tuned frequency. arm rf transmit first, and attach an antenna or a dummy load so the output is not driving an open port.',
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

class HackRfSession implements DeviceSession {
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
      if (!this.ctx.isArmed(CAPABILITIES.TRANSMIT_RF)) {
        throw new Error(
          'transmit is not armed. arm rf transmit on this device, check the band is one you may transmit on, and attach an antenna or a dummy load before starting again.',
        )
      }
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

    if (head === 'tx') {
      await this.setTxVga(this.params.txvga)
      this.applied.txvga = this.params.txvga
      await this.setTransceiverMode(MODE.TRANSMIT)
      this.ctx.log(
        `transmitting a carrier at ${(this.params.centerHz / 1e6).toFixed(3)} MHz, tx gain ${Math.round(this.params.txvga)} dB`,
      )
      void this.transmitCarrier(abort.signal)
      return
    }

    this.abort = null
    throw new Error(`hackrf has no mode called ${mode}`)
  }

  async stop(): Promise<void> {
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

  /**
   * A constant baseband offset comes out as an unmodulated carrier at the
   * tuned frequency. Amplitude sits below full scale so the DAC does not clip.
   */
  private async transmitCarrier(signal: AbortSignal): Promise<void> {
    const buf = new Int8Array(TRANSFER_BYTES)
    for (let i = 0; i < buf.length; i += 2) {
      buf[i] = 96
      buf[i + 1] = 0
    }
    while (!signal.aborted && this.usb.isOpen) {
      try {
        await this.usb.bulkOut(EP_TX, buf)
      } catch {
        if (signal.aborted || !this.usb.isOpen) return
        await new Promise((r) => setTimeout(r, 5))
      }
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
    const session = new HackRfSession(port, ctx)
    await session.init()
    return session
  },
}

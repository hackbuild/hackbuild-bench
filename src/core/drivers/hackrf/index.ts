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

/** hackrf_board_id in hackrf.h. Rev 9 is the board shipping now. */
const BOARD_NAMES: Record<number, string> = {
  0: 'jellybean',
  1: 'jawbreaker',
  2: 'hackrf one',
  3: 'rad1o',
  4: 'hackrf one r9',
  5: 'praline',
  0xfe: 'unrecognized',
  0xff: 'undetected',
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
/** The same ceiling in samples, so a high sample rate cannot turn a legal
 *  duration into a buffer the tab has to hold. */
const TX_FRAME_LIMIT_SAMPLES = 2000000 * TX_FRAME_LIMIT_SECONDS
/** afskAudio prepends this many preamble bits by default. */
const AFSK_PREAMBLE_BITS = 32
/** Wall clock cap on the flush at the end of a transmission. */
const TX_FLUSH_TIMEOUT_MS = 2000
/** Wall clock cap on the mode change out of transmit. */
const MODE_OFF_TIMEOUT_MS = 500
const FFT_SIZE = 2048
/**
 * Transfers dropped after a retune. They still carry the old frequency, and
 * waiting on them is also what gives the pll time to settle: a timer cannot be
 * used for that, a background tab throttles setTimeout to one second and the
 * sweep collapses to a step per second. A transfer is paced by the radio.
 */
const SWEEP_DISCARD = 3
/** Publish spectrum at 20 fps whatever the sample rate feeds in. */
const FFT_INTERVAL_MS = 50
const AUDIO_RATE = 48000
/** The level the sweep reports for a step the tuner has not reached yet. */
const SWEEP_FLOOR_DB = -140
/**
 * How long a pass runs before the sweep starts publishing part of it. A narrow
 * range finishes inside this and goes out whole, which keeps the floor the
 * display picks off the steps that are actually filled. A range wide enough to
 * take minutes paints as it goes rather than leaving the panel blank.
 */
const SWEEP_PARTIAL_AFTER_MS = 1000

/**
 * max2837_ft in libhackrf hackrf.c. The firmware rounds a request up to the
 * first entry at or above it, and past the last entry it writes no register at
 * all and the filter silently keeps whatever it had.
 */
const BASEBAND_FILTER_BW = [
  1750000, 2500000, 3500000, 5000000, 5500000, 6000000, 7000000, 8000000, 9000000, 10000000,
  12000000, 14000000, 15000000, 20000000, 24000000, 28000000,
]

/**
 * The narrowest table entry at or above hz. The sweep keeps 75 percent of each
 * window, so a filter narrower than the request would roll off inside the part
 * that is stitched.
 */
function basebandFilterBw(hz: number): number {
  const last = BASEBAND_FILTER_BW.length - 1
  const want = clamp(hz, BASEBAND_FILTER_BW[0], BASEBAND_FILTER_BW[last])
  let i = 0
  while (i < last && BASEBAND_FILTER_BW[i] < want) i++
  return BASEBAND_FILTER_BW[i]
}

const USB_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x1d50, productId: 0x6089 },
  { vendorId: 0x1d50, productId: 0x604b },
  { vendorId: 0x1d50, productId: 0xcc15 },
]

/** The filters accept three boards, so the rail names the one that answered. */
const PRODUCT_NAMES: Record<number, string> = {
  0x6089: 'HackRF One',
  0x604b: 'HackRF Jawbreaker',
  0xcc15: 'rad1o',
}

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
    { key: 'sweepLowHz', label: 'sweep from', unit: 'Hz', min: 1e6, max: 6000e6, default: 400e6, log: true },
    { key: 'sweepHighHz', label: 'sweep to', unit: 'Hz', min: 1e6, max: 6000e6, default: 500e6, log: true },
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
 * Tools ask the bus for a capability, never for a device kind, so the same
 * request has to work on every radio that provides it. A panel wanting raw
 * samples asks for iq and one wanting bins asks for spectrum. Both are the
 * receive stream here, which emits samples and bins together.
 */
function askedFor(mode: string): string {
  if (mode === 'iq' || mode === 'spectrum') return 'rx'
  return mode
}

/**
 * Subtracts the mean from interleaved IQ in place.
 *
 * A zero if front end leaves a dc offset that lands in the middle of the
 * window, which draws as a carrier that is not on the air. In a sweep it is
 * worse: one at the centre of every step, a comb of signals that do not exist.
 * Only the copy the fft sees is corrected, the samples handed out are the ones
 * the radio sent.
 */
function removeDc(iq: Float32Array): void {
  const pairs = iq.length >> 1
  if (pairs === 0) return
  let si = 0
  let sq = 0
  for (let i = 0; i < pairs; i++) {
    si += iq[i * 2]
    sq += iq[i * 2 + 1]
  }
  const mi = si / pairs
  const mq = sq / pairs
  for (let i = 0; i < pairs; i++) {
    iq[i * 2] -= mi
    iq[i * 2 + 1] -= mq
  }
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
  // seeded straight off the descriptor, so the knobs the panel shows and the
  // values the radio runs on cannot drift apart. every key the sweep reads,
  // sweepLowHz and sweepHighHz included, has to exist in the descriptor.
  private params: Record<string, number> = Object.fromEntries(
    hackrfDescriptor.params.map((p) => [p.key, p.default]),
  )
  private applied: Record<string, number> = {}
  private info: Record<string, string> = {}
  private analyzer = new SpectrumAnalyzer(FFT_SIZE)
  private fftScratch = new Float32Array(FFT_SIZE * 2)
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
  private txClosing = false
  private txClosingPromise: Promise<void> | null = null
  private txRestore: Record<string, number> | null = null
  /** True while a mode change the radio has not acknowledged is still in the
   *  device queue. Webusb serialises control transfers, so anything sent now
   *  waits behind it. */
  private controlStalled = false

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
    const bw = basebandFilterBw(0.75 * sps)
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

  /**
   * The firmware withholds the acknowledgement for the mode change out of
   * transmit until the m0 has sent everything the host queued, and a webusb
   * control transfer carries no timeout of its own. Webusb serialises control
   * transfers on the device, so waiting forever wedges every later one.
   */
  private async modeOff(): Promise<void> {
    let failure: unknown
    const done = this.setTransceiverMode(MODE.OFF).then(
      () => 'ok' as const,
      (err: unknown) => {
        failure = err
        return 'failed' as const
      },
    )
    void done.then(() => {
      this.controlStalled = false
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), MODE_OFF_TIMEOUT_MS)
    })
    const which = await Promise.race([done, expired])
    clearTimeout(timer)
    if (which === 'failed') throw failure
    if (which === 'expired') {
      this.controlStalled = true
      this.ctx.log(`the radio did not acknowledge transmit off within ${MODE_OFF_TIMEOUT_MS} ms`)
    }
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
    // a tune through the normal path is where the user wants the radio, so the
    // snapshot transmit would put back is dropped.
    this.txRestore = null
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

  /**
   * The streaming loops run detached from start, so without this a failure in
   * one is an unhandled rejection: the panel just sits there showing nothing.
   */
  private detach(what: string, run: Promise<void>): void {
    void run.catch((err: unknown) => {
      const why = err instanceof Error ? err.message : String(err)
      this.ctx.log(`${what} stopped: ${why}`)
    })
  }

  async start(mode: string): Promise<void> {
    await this.stop()
    const [head, tail] = askedFor(mode).split(':')

    if (head === 'tx') {
      await this.beginTransmit()
      this.ctx.log(
        `carrier out at ${(this.params.centerHz / 1e6).toFixed(3)} MHz, tx gain ${Math.round(this.params.txvga)} dB`,
      )
      this.detach('carrier', this.carrierLoop())
      return
    }

    await this.applyRadio(false)
    const abort = new AbortController()
    this.abort = abort

    if (head === 'rx') {
      await this.setTransceiverMode(MODE.RECEIVE)
      this.detach('receive', this.receive(abort.signal, null))
      return
    }

    if (head === 'sweep') {
      await this.setTransceiverMode(MODE.RECEIVE)
      this.detach('sweep', this.sweep(abort.signal))
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
      this.detach('audio', this.receive(abort.signal, demod))
      return
    }

    this.abort = null
    throw new Error(
      `hackrf has no mode called ${mode}. it takes iq, spectrum, sweep, tx, or audio with one of fm, nfm, am, usb, lsb.`,
    )
  }

  async stop(): Promise<void> {
    if (this.txActive || this.txPump) await this.endTransmit()
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
    // quietest first, and every step runs even when the one before it failed.
    // this is the path whose whole job is to leave the radio silent.
    const steps: Array<[string, () => Promise<void>]> = [
      ['transceiver mode off', () => this.modeOff()],
      [
        'the front end amp off',
        async () => {
          await this.setAmp(false)
          this.applied.amp = 0
        },
      ],
      [
        'transmit gain to zero',
        async () => {
          await this.setTxVga(0)
          this.applied.txvga = 0
        },
      ],
    ]
    for (const [what, run] of steps) {
      if (this.controlStalled) {
        this.ctx.log(`the radio is still holding a control transfer, the reset stopped before ${what}`)
        break
      }
      try {
        await run()
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        this.ctx.log(`the radio would not take ${what}: ${why}`)
      }
    }
    // applied is left alone where a step failed, so the next configure sends it
    // again.
    this.params.amp = 0
    this.params.txvga = 0
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

  /**
   * Wideband sweep by stepping the tuner across a range, one FFT per step,
   * stitched into a panorama. This scans far wider than the instantaneous
   * window using only the verified setFreq and fft paths, at the cost of being
   * slower than the device's native hardware sweep.
   *
   * Each step keeps the middle 75 percent of its window and drops the edges
   * where the baseband filter rolls off. The panorama therefore covers whole
   * steps, not the requested range exactly, so the frame reports the span it
   * actually holds and the display cannot stretch it onto the wrong
   * frequencies.
   */
  private async sweep(signal: AbortSignal): Promise<void> {
    const lowHz = Math.max(1e6, this.params.sweepLowHz || 1e6)
    const highHz = Math.max(lowHz + 1e6, Math.min(6000e6, this.params.sweepHighHz || 6000e6))
    const rate = this.params.sampleRate
    const usable = rate * 0.75
    const segBins = Math.floor(FFT_SIZE * 0.75)
    const edge = Math.floor((FFT_SIZE - segBins) / 2)
    // whole steps from lowHz up, so the last one may reach past highHz.
    const steps = Math.max(1, Math.ceil((highHz - lowHz) / usable))
    const spanHz = steps * usable
    const scratch = new Float32Array(FFT_SIZE * 2)
    const panorama = new Float32Array(steps * segBins)
    let lastEmitAt = 0

    while (!signal.aborted && this.usb.isOpen) {
      // the steps the tuner has not reached yet read as floor, so a frame
      // published mid pass still covers the span it says it covers.
      panorama.fill(SWEEP_FLOOR_DB)
      const passStart = performance.now()
      let filled = 0
      for (let step = 0; step < steps && !signal.aborted; step++) {
        const center = lowHz + usable * (step + 0.5)
        let chunk: Uint8Array
        try {
          await this.setFreq(center)
          // the radio is left where the sweep put it, so a later tune knows to
          // move it back rather than assuming centerHz is still applied.
          this.applied.centerHz = center
          // the endpoint still holds samples from the previous step, so the
          // first transfers after a retune are thrown away. reading them is
          // also the settle time, paced by the radio rather than by a timer.
          for (let i = 0; i < SWEEP_DISCARD; i++) await this.usb.bulkIn(EP_RX, TRANSFER_BYTES)
          chunk = await this.usb.bulkIn(EP_RX, TRANSFER_BYTES)
        } catch (err) {
          if (signal.aborted) return
          // a swallowed read failure here leaves the panel blank with nothing
          // to explain it, so say which step gave up.
          const why = err instanceof Error ? err.message : String(err)
          this.ctx.log(`sweep gave up at ${(center / 1e6).toFixed(3)} MHz: ${why}`)
          break
        }
        const s = new Int8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        const n = Math.min(s.length, scratch.length)
        for (let i = 0; i < n; i++) scratch[i] = s[i] / 127
        for (let i = n; i < scratch.length; i++) scratch[i] = 0
        removeDc(scratch)
        const bins = this.analyzer.process(scratch)
        panorama.set(bins.subarray(edge, edge + segBins), filled)
        filled += segBins
        const now = performance.now()
        if (now - passStart >= SWEEP_PARTIAL_AFTER_MS && now - lastEmitAt >= FFT_INTERVAL_MS) {
          lastEmitAt = now
          this.emitPanorama(panorama, lowHz, spanHz)
        }
      }
      if (signal.aborted) return
      if (filled === 0) {
        this.ctx.log('sweep produced nothing, stopping')
        return
      }
      lastEmitAt = performance.now()
      this.emitPanorama(panorama, lowHz, spanHz)
    }
  }

  /**
   * The sweep refills one buffer for the whole session, and the panels compare
   * frames by identity and hold what they are handed, so each publish carries
   * its own copy.
   */
  private emitPanorama(panorama: Float32Array, lowHz: number, spanHz: number): void {
    const frame: Emitted<FftFrame> = {
      kind: 'fft',
      bins: panorama.slice(),
      centerHz: lowHz + spanHz / 2,
      sampleRate: spanHz,
    }
    this.ctx.emit(frame)
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
    this.fftScratch.set(iq.subarray(0, FFT_SIZE * 2))
    removeDc(this.fftScratch)
    const frame: Emitted<FftFrame> = {
      kind: 'fft',
      bins: this.analyzer.process(this.fftScratch).slice(),
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
    // the bus holds its own copy of the params and there is no hook to tell it
    // these, so the settings the panels are showing are put back afterwards.
    if (!this.txRestore) {
      this.txRestore = { centerHz: this.params.centerHz, sampleRate: this.params.sampleRate }
    }
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

  /**
   * Ends transmit once the queue has actually reached the radio. A caller
   * returns from its last write as soon as the samples are queued, with the
   * pump still to send them, so cutting it there truncates the transmission.
   */
  async endTransmit(): Promise<void> {
    if (this.txClosingPromise) return this.txClosingPromise
    if (!this.txActive && !this.txPump) return
    const run = this.runEndTransmit()
    this.txClosingPromise = run
    try {
      await run
    } finally {
      this.txClosingPromise = null
    }
  }

  private async runEndTransmit(): Promise<void> {
    if (this.txActive) {
      // producers stop adding while the queue drains. the carrier loop would
      // otherwise refill it for as long as the flush waits.
      this.txClosing = true
      this.wake(this.txRoom)
      try {
        await this.flushTx()
      } finally {
        this.txClosing = false
      }
    }

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
      await this.modeOff()
      // the amplifier goes off between transmissions. a send turns it back on.
      if (!this.controlStalled) {
        await this.setAmp(false)
        this.applied.amp = 0
      }
      this.params.amp = 0
    } catch {
      // nothing left to quiet down when the device is gone.
    }

    const restore = this.txRestore
    this.txRestore = null
    if (!restore) return
    this.params = { ...this.params, ...restore }
    // applied keeps the transmit values, so the next configure resends these.
    if (this.controlStalled) return
    try {
      await this.applyRadio(false)
    } catch {
      // the next configure resends whatever did not land.
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
      await this.endTransmit()
    }
  }

  async transmitFrame(bytes: Uint8Array, opts: TransmitFrameOptions = {}): Promise<void> {
    this.requireTxArm()
    if (bytes.length === 0) throw new Error('the frame is empty, there is nothing to send.')

    const rate = this.params.sampleRate
    const keying = opts.mode ?? 'ook'
    const bitRate = clamp(Math.round(opts.bitRate ?? 2000), 50, 200000)
    const bits = bytes.length * 8 + (keying === 'afsk' ? AFSK_PREAMBLE_BITS : 0)
    const seconds = bits / bitRate
    if (seconds > TX_FRAME_LIMIT_SECONDS) {
      throw new Error(
        `that frame runs ${seconds.toFixed(1)} s at ${bitRate} bits per second, past the ${TX_FRAME_LIMIT_SECONDS} s ceiling. shorten it or raise the rate.`,
      )
    }
    const frames = Math.round(seconds * rate)
    if (frames > TX_FRAME_LIMIT_SAMPLES) {
      throw new Error(
        `that frame is ${(frames / 1e6).toFixed(1)}M samples at ${(rate / 1e6).toFixed(1)} Msps, past the ceiling. shorten it, raise the bit rate, or drop the sample rate.`,
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
      while (this.txActive && !this.txClosing && this.txQueued >= TX_QUEUE_BYTES) {
        await new Promise<void>((resolve) => this.txRoom.push(resolve))
      }
      if (!this.txActive || this.txClosing) return
      const piece = buf.subarray(off, Math.min(off + TRANSFER_BYTES, buf.length))
      this.txChunks.push(piece)
      this.txQueued += piece.length
    }
  }

  private async drainTx(deadline: number): Promise<void> {
    while (this.txActive && this.txQueued > 0) {
      const left = deadline - performance.now()
      if (left <= 0) return
      await this.waitFor(this.txIdle, left)
    }
  }

  /**
   * Waits for the queue to reach the radio, then sends one block of zeros so
   * the last real samples are pushed clear of the device's own fifo. Capped on
   * the wall clock so an unresponsive radio cannot hold the panel.
   */
  private async flushTx(): Promise<void> {
    const deadline = performance.now() + TX_FLUSH_TIMEOUT_MS
    await this.drainTx(deadline)
    if (!this.txActive) return
    const tail = new Int8Array(TRANSFER_BYTES)
    this.txChunks.push(tail)
    this.txQueued += tail.length
    await this.drainTx(deadline)
  }

  /** Resolves on the next wake or when the wait runs out, whichever is first. */
  private waitFor(waiters: Array<() => void>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(finish, ms)
      waiters.push(finish)
    })
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
    let lastError = ''

    const send = async (buf: Int8Array<ArrayBuffer>): Promise<void> => {
      try {
        await this.usb.bulkOut(EP_TX, buf)
        faults = 0
      } catch (err) {
        faults++
        lastError = err instanceof Error ? err.message : String(err)
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
    if (signal.aborted) return

    // the pump is the only thing that wakes a blocked producer, so an exit it
    // was not asked for has to release them and say why, and quiet the radio
    // that is still in transmit.
    this.txActive = false
    this.txChunks = []
    this.txQueued = 0
    this.wake(this.txRoom)
    this.wake(this.txIdle)
    this.ctx.log(`transmit stopped: ${lastError || 'the radio closed the usb endpoint'}`)
    try {
      await this.modeOff()
      if (!this.controlStalled) {
        await this.setAmp(false)
        this.applied.amp = 0
      }
      this.params.amp = 0
    } catch {
      // nothing left to quiet down when the device is gone.
    }
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
    while (this.txActive && !this.txClosing) {
      await this.queue(block)
    }
  }
}

function handleFor(port: UsbPort): DeviceHandle {
  return {
    kind: 'hackrf',
    transport: 'webusb',
    uid: port.serial || port.productName,
    label: PRODUCT_NAMES[port.productId] ?? port.productName,
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

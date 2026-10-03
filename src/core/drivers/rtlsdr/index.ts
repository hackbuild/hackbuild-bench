/**
 * RTL-SDR driver: RTL2832U demodulator with an R820T family tuner. That covers
 * the generic blue dongles, the RTL-SDR Blog v3, and every Nooelec NESDR Mini,
 * Nano and SMArt.
 *
 * Receive only. The dongle has no transmitter. Its bias tee gpio survives across
 * sessions and across other host applications, so reset clears it.
 */

import { CAPABILITIES } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import type { DeviceDescriptor, FftFrame, IqChunk, TransportKind } from '@/core/types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '@/core/drivers/types'
import { UsbPort } from '@/core/transport/webusb'
import { SpectrumAnalyzer } from '@/core/dsp/fft'
import { R820T } from './r820t'
import { BLOCK, IF_FREQ, REG, RTL_DEVICES, RtlCom, XTAL } from './rtlcom'
import type { RtlOp } from './rtlcom'

/** Bulk in endpoint carrying the 8 bit IQ stream. */
const IQ_ENDPOINT = 1

const XFER_BYTES = 16384
const XFER_DEPTH = 16

/** Spectrum frames past this rate are dropped rather than queued. */
const FFT_MIN_INTERVAL_MS = 1000 / 30

const FFT_SIZE = 2048

/** Above this the gain slider means let the tuner decide. */
const GAIN_AUTO_AT = 49

/** A transfer lands within milliseconds at every rate on offer, so this is dead. */
const STREAM_STALL_MS = 3000

const STALL_POLL_MS = 1000

const USB_FILTERS: USBDeviceFilter[] = RTL_DEVICES.map(([vendorId, productId]) => ({
  vendorId,
  productId,
}))

/** The product string Realtek burns in when the maker left the eeprom alone. */
const GENERIC_PRODUCT = /^rtl28\d\d/i

interface TunerProbe {
  name: string
  addr: number
  reg: number
  match: (v: number) => boolean
  afterReset?: boolean
  note?: string
}

/**
 * Tuners other than the R820T family, in the order librtlsdr probes them.
 * Found only so the refusal can name the chip. The last two answer only after
 * a reset pulse on gpio 4.
 */
const OTHER_TUNERS: TunerProbe[] = [
  { name: 'e4000', addr: 0xc8, reg: 0x02, match: (v) => v === 0x40, note: 'as on the nesdr xtr' },
  { name: 'fc0013', addr: 0xc6, reg: 0x00, match: (v) => v === 0xa3 },
  { name: 'r828d', addr: 0x74, reg: 0x00, match: (v) => v === 0x69, note: 'as on the rtl-sdr blog v4' },
  { name: 'fc2580', addr: 0xac, reg: 0x01, match: (v) => (v & 0x7f) === 0x56, afterReset: true },
  { name: 'fc0012', addr: 0xc6, reg: 0x00, match: (v) => v === 0xa1, afterReset: true },
]

/**
 * The RTL2832U bring up sequence. The 0x1c to 0x2f run is the demod fir
 * coefficient table for the programmable channel filter.
 */
const INIT_OPS: RtlOp[] = [
  ['reg', BLOCK.USB, REG.SYSCTL, 0x09, 1],
  ['reg', BLOCK.USB, REG.EPA_MAXPKT, 0x0200, 2],
  ['reg', BLOCK.USB, REG.EPA_CTL, 0x0210, 2],
  ['reg', BLOCK.SYS, REG.DEMOD_CTL_1, 0x22, 1],
  ['reg', BLOCK.SYS, REG.DEMOD_CTL, 0xe8, 1],
  ['demod', 1, 0x01, 0x14, 1],
  ['demod', 1, 0x01, 0x10, 1],
  ['demod', 1, 0x15, 0x00, 1],
  ['demod', 1, 0x16, 0x0000, 2],
  ['demod', 1, 0x16, 0x00, 1],
  ['demod', 1, 0x17, 0x00, 1],
  ['demod', 1, 0x18, 0x00, 1],
  ['demod', 1, 0x19, 0x00, 1],
  ['demod', 1, 0x1a, 0x00, 1],
  ['demod', 1, 0x1b, 0x00, 1],
  ['demod', 1, 0x1c, 0xca, 1],
  ['demod', 1, 0x1d, 0xdc, 1],
  ['demod', 1, 0x1e, 0xd7, 1],
  ['demod', 1, 0x1f, 0xd8, 1],
  ['demod', 1, 0x20, 0xe0, 1],
  ['demod', 1, 0x21, 0xf2, 1],
  ['demod', 1, 0x22, 0x0e, 1],
  ['demod', 1, 0x23, 0x35, 1],
  ['demod', 1, 0x24, 0x06, 1],
  ['demod', 1, 0x25, 0x50, 1],
  ['demod', 1, 0x26, 0x9c, 1],
  ['demod', 1, 0x27, 0x0d, 1],
  ['demod', 1, 0x28, 0x71, 1],
  ['demod', 1, 0x29, 0x11, 1],
  ['demod', 1, 0x2a, 0x14, 1],
  ['demod', 1, 0x2b, 0x71, 1],
  ['demod', 1, 0x2c, 0x74, 1],
  ['demod', 1, 0x2d, 0x19, 1],
  ['demod', 1, 0x2e, 0x41, 1],
  ['demod', 1, 0x2f, 0xa5, 1],
  ['demod', 0, 0x19, 0x05, 1],
  ['demod', 1, 0x93, 0xf0, 1],
  ['demod', 1, 0x94, 0x0f, 1],
  ['demod', 1, 0x11, 0x00, 1],
  ['demod', 1, 0x04, 0x00, 1],
  ['demod', 0, 0x61, 0x60, 1],
  ['demod', 0, 0x06, 0x80, 1],
  ['demod', 1, 0xb1, 0x1b, 1],
  ['demod', 0, 0x0d, 0x83, 1],
]

// ---------------------------------------------------------------------------
// hardware
// ---------------------------------------------------------------------------

class RtlSdr {
  readonly port: UsbPort
  readonly com: RtlCom
  tuner: R820T | null = null
  tunerName = ''
  ppm = 0
  rate = 0
  freq = 100000000
  /** False when the pll did not report lock at the last tune. */
  tunerLocked = true

  constructor(port: UsbPort) {
    this.port = port
    this.com = new RtlCom(port)
  }

  private correctedXtal(): number {
    return Math.floor(XTAL * (1 + this.ppm / 1e6))
  }

  async open(ppm: number): Promise<void> {
    this.ppm = ppm || 0
    const com = this.com
    try {
      await this.port.claim({ configuration: 1, interface: 0 })
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      throw new Error(
        `the dongle is held by something else (${why}). close any other sdr app using it. ` +
          'on linux, unload the dvb_usb_rtl28xxu kernel driver. on windows, give it the winusb ' +
          'driver with zadig.',
      )
    }
    await com.writeEach(INIT_OPS)

    await com.i2cOpen()
    try {
      if (!(await R820T.detect(com))) throw new Error(await this.unsupportedTuner())
      this.tuner = new R820T(com, this.correctedXtal())
      this.tunerName = 'r820t/r820t2'
      await com.writeEach([
        ['demod', 1, 0xb1, 0x1a, 1],
        ['demod', 0, 0x08, 0x4d, 1],
      ])
      await this.setIfFreq(IF_FREQ)
      await com.writeDemod(1, 0x15, 0x01, 1)
      await this.tuner.init()
    } finally {
      try {
        await com.i2cClose()
      } catch {
        // on an unplugged device the gate close fails too, and the tuner
        // failure is the one the caller needs.
      }
    }
  }

  /** Names whatever tuner answered instead, for the refusal. The i2c gate is open. */
  private async unsupportedTuner(): Promise<string> {
    let reset = false
    for (const t of OTHER_TUNERS) {
      if (t.afterReset && !reset) {
        await this.setGpioOutput(4)
        await this.setGpioBit(4, true)
        await this.setGpioBit(4, false)
        reset = true
      }
      const v = await this.com.i2cProbe(t.addr, t.reg)
      if (v !== null && t.match(v)) {
        const note = t.note ? `, ${t.note}` : ''
        return `this dongle has an ${t.name} tuner${note}. only the r820t family is supported so far.`
      }
    }
    return 'no tuner answered on the i2c bus. unplug the dongle, plug it back in, and connect again.'
  }

  async setIfFreq(hz: number): Promise<void> {
    const xtal = this.correctedXtal()
    const v = Math.trunc(-1 * Math.trunc((hz * 4194304) / xtal))
    await this.com.writeEach([
      ['demod', 1, 0x19, (v >> 16) & 0x3f, 1],
      ['demod', 1, 0x1a, (v >> 8) & 0xff, 1],
      ['demod', 1, 0x1b, v & 0xff, 1],
    ])
  }

  /** Returns the rate the resampler actually lands on, which is what dsp uses. */
  async setSampleRate(rate: number): Promise<number> {
    // the ratio register is 28 bits with bit 27 acting as a sign, which is what
    // lets rates below about 450 k work at all.
    const ratio = Math.floor((XTAL * 4194304) / rate) & 0x0ffffffc
    const realRatio = ratio | ((ratio & 0x08000000) << 1)
    const real = (XTAL * 4194304) / realRatio
    const off = -1 * Math.floor((this.ppm * 16777216) / 1e6)
    await this.com.writeEach([
      ['demod', 1, 0x9f, (ratio >> 16) & 0xffff, 2],
      ['demod', 1, 0xa1, ratio & 0xffff, 2],
      ['demod', 1, 0x3e, (off >> 8) & 0x3f, 1],
      ['demod', 1, 0x3f, off & 0xff, 1],
      ['demod', 1, 0x01, 0x14, 1],
      ['demod', 1, 0x01, 0x10, 1],
    ])
    this.rate = real
    return real
  }

  /** The tuner is parked IF_FREQ above, since the demod shifts it back down. */
  async setCenterFrequency(hz: number): Promise<number> {
    if (!this.tuner) throw new Error('tuner is not initialised')
    await this.com.i2cOpen()
    let actual: number | null
    try {
      actual = await this.tuner.setFrequency(hz + IF_FREQ)
    } finally {
      await this.com.i2cClose()
    }
    this.tunerLocked = this.tuner.pllLock
    this.freq = actual === null ? hz : actual - IF_FREQ
    return this.freq
  }

  async setGain(db: number | null): Promise<void> {
    if (!this.tuner) throw new Error('tuner is not initialised')
    await this.com.i2cOpen()
    try {
      if (db === null) await this.tuner.setAutoGain()
      else await this.tuner.setManualGain(db)
    } finally {
      await this.com.i2cClose()
    }
  }

  async setDigitalAgc(on: boolean): Promise<void> {
    await this.com.writeDemod(0, 0x19, on ? 0x25 : 0x05, 1)
  }

  async setPpm(ppm: number): Promise<void> {
    this.ppm = ppm
    this.tuner?.setXtal(this.correctedXtal())
    await this.setIfFreq(IF_FREQ)
    await this.setSampleRate(this.rate)
    await this.setCenterFrequency(this.freq)
  }

  async setGpioOutput(bit: number): Promise<void> {
    const m = 1 << bit
    let r = await this.com.readReg(BLOCK.SYS, REG.GPD, 1)
    await this.com.writeReg(BLOCK.SYS, REG.GPD, r & ~m, 1)
    r = await this.com.readReg(BLOCK.SYS, REG.GPOE, 1)
    await this.com.writeReg(BLOCK.SYS, REG.GPOE, r | m, 1)
  }

  async setGpioBit(bit: number, val: boolean): Promise<void> {
    const m = 1 << bit
    const r = await this.com.readReg(BLOCK.SYS, REG.GPO, 1)
    await this.com.writeReg(BLOCK.SYS, REG.GPO, val ? r | m : r & ~m, 1)
  }

  /** Bias tee is gpio bit 0 on every board in this family. */
  async setBiasTee(on: boolean): Promise<void> {
    await this.setGpioOutput(0)
    await this.setGpioBit(0, on)
  }

  async resetBuffer(): Promise<void> {
    await this.com.writeEach([
      ['reg', BLOCK.USB, REG.EPA_CTL, 0x0210, 2],
      ['reg', BLOCK.USB, REG.EPA_CTL, 0x0000, 2],
    ])
  }

  /** The i2c gate and the demod power state outlive the port, so both are cleared here. */
  async close(): Promise<void> {
    if (this.tuner) {
      try {
        await this.com.i2cOpen()
        try {
          await this.tuner.shutdown()
        } finally {
          await this.com.i2cClose()
        }
      } catch {
        // already unplugged. the rest of the teardown is still worth attempting.
      }
    }
    try {
      // 0x20 powers the demodulator and the adcs down, undoing the 0xe8 in INIT_OPS.
      await this.com.writeReg(BLOCK.SYS, REG.DEMOD_CTL, 0x20, 1)
    } catch {
      // already unplugged. releasing the interface is still worth attempting.
    }
    await this.port.release()
  }
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

class RtlSession implements DeviceSession {
  private sdr: RtlSdr
  private ctx: DriverContext
  private info: Record<string, string>
  private analyzer = new SpectrumAnalyzer(FFT_SIZE)
  private lastFft = 0
  private pumping: Promise<void> | null = null
  /** Held past a stream failure so teardown still waits for the transfers to unwind. */
  private pending: Promise<void> | null = null
  private abort: AbortController | null = null
  private lastChunk = 0
  private stallMisses = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private streamFailed = false
  /** Control transfers must not interleave, i2c least of all. */
  private queue: Promise<unknown> = Promise.resolve()
  private applied: Record<string, number> = {}

  constructor(
    sdr: RtlSdr,
    ctx: DriverContext,
    info: Record<string, string>,
    applied: Record<string, number>,
  ) {
    this.sdr = sdr
    this.ctx = ctx
    this.info = info
    this.applied = applied
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  getCapabilities(): Capability[] {
    return [CAPABILITIES.OBSERVE_SPECTRUM, CAPABILITIES.CAPTURE_IQ, CAPABILITIES.AUDIO_DEMOD]
  }

  getInfo(): Record<string, string> {
    return this.info
  }

  async configure(params: Record<string, number>): Promise<void> {
    await this.serial(async () => {
      if (params.ppm !== undefined && params.ppm !== this.applied.ppm) {
        await this.sdr.setPpm(params.ppm)
        this.applied.ppm = params.ppm
        this.applied.sampleRate = this.sdr.rate
        this.applied.centerHz = this.sdr.freq
      }
      if (params.sampleRate !== undefined && params.sampleRate !== this.applied.sampleRate) {
        const real = await this.sdr.setSampleRate(params.sampleRate)
        this.applied.sampleRate = params.sampleRate
        this.info.sampleRate = `${Math.round(real)} sps`
        this.ctx.setInfo({ sampleRate: this.info.sampleRate })
      }
      if (params.centerHz !== undefined && params.centerHz !== this.applied.centerHz) {
        await this.sdr.setCenterFrequency(params.centerHz)
        this.applied.centerHz = params.centerHz
        this.info.pll = this.sdr.tunerLocked ? 'locked' : 'no lock'
        this.ctx.setInfo({ pll: this.info.pll })
        if (!this.sdr.tunerLocked) {
          this.ctx.log(`tuner pll did not lock at ${Math.round(params.centerHz)} hz`)
        }
      }
      if (params.gain !== undefined && params.gain !== this.applied.gain) {
        await this.sdr.setGain(params.gain >= GAIN_AUTO_AT ? null : params.gain)
        this.applied.gain = params.gain
      }
    })
  }

  async start(mode: string): Promise<void> {
    // a tool asks by capability, so iq, rx and spectrum name the same stream.
    // this radio emits samples, and the bins come off them the same way.
    if (mode !== 'iq' && mode !== 'rx' && mode !== 'spectrum') {
      throw new Error(`rtl-sdr has no ${mode} mode. it takes iq, spectrum, or rx.`)
    }
    if (this.pumping) return

    const abort = new AbortController()
    this.abort = abort
    this.ctx.signal.addEventListener('abort', () => abort.abort(), {
      once: true,
      signal: abort.signal,
    })

    const previous = this.pending
    this.pending = null
    if (previous) await previous.catch(() => undefined)

    await this.serial(() => this.sdr.resetBuffer())
    this.streamFailed = false
    this.stallMisses = 0
    this.lastChunk = performance.now()
    const pumping = this.sdr.port.stream(
      IQ_ENDPOINT,
      XFER_BYTES,
      XFER_DEPTH,
      (chunk) => this.onChunk(chunk),
      abort.signal,
    )
    this.pumping = pumping
    this.pending = pumping
    void pumping.then(
      () => {
        if (this.pumping !== pumping) return
        this.clearWatchdog()
        if (abort.signal.aborted) return
        this.failStream('the usb read loop exited on its own')
      },
      (err: unknown) => {
        if (this.pumping !== pumping) return
        this.failStream(err instanceof Error ? err.message : String(err))
      },
    )
    this.watchdog = setInterval(() => this.checkStall(), STALL_POLL_MS)
    this.ctx.log(`streaming iq at ${Math.round(this.sdr.rate)} sps`)
  }

  /**
   * The transport returns normally when the device closes under it, so a stream
   * that ends without this session aborting is a failure.
   */
  private failStream(reason: string): void {
    if (this.streamFailed || !this.pumping) return
    this.streamFailed = true
    this.clearWatchdog()
    this.abort?.abort()
    this.abort = null
    this.pumping = null
    this.ctx.log(`iq stream stopped: ${reason}`)
  }

  /**
   * A frozen tab stops performance.now and the transfers together, so the first
   * poll after it resumes reads as a stall on a live stream. Only a miss that
   * repeats on the next poll is real.
   */
  private checkStall(): void {
    if (!this.pumping) return
    if (performance.now() - this.lastChunk < STREAM_STALL_MS) {
      this.stallMisses = 0
      return
    }
    this.stallMisses++
    if (this.stallMisses < 2) return
    this.failStream(`no usb transfer completed for ${STREAM_STALL_MS / 1000} seconds`)
  }

  private clearWatchdog(): void {
    if (this.watchdog === null) return
    clearInterval(this.watchdog)
    this.watchdog = null
  }

  async stop(): Promise<void> {
    this.clearWatchdog()
    this.streamFailed = false
    this.stallMisses = 0
    this.abort?.abort()
    this.abort = null
    this.pumping = null
    const pending = this.pending
    this.pending = null
    if (pending) await pending.catch(() => undefined)
  }

  async resetToSafeState(): Promise<void> {
    await this.stop()
    try {
      await this.serial(() => this.sdr.setBiasTee(false))
    } catch {
      // the device may already be gone, in which case its bias tee is off too.
    }
  }

  async close(): Promise<void> {
    await this.stop()
    await this.serial(() => this.sdr.close())
  }

  async health(): Promise<boolean> {
    return this.sdr.port.isOpen && !this.streamFailed
  }

  /** 8 bit unsigned IQ pairs, offset binary around 127.5. */
  private onChunk(chunk: Uint8Array): void {
    this.lastChunk = performance.now()
    const n = chunk.length & ~1
    if (n === 0) return

    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = (chunk[i] - 127.5) / 127.5

    const centerHz = this.sdr.freq
    const sampleRate = this.sdr.rate

    const iq: Omit<IqChunk, 'source' | 'seq' | 't' | 'wall'> = {
      kind: 'iq',
      samples,
      centerHz,
      sampleRate,
      // a short bulk transfer is not a lost sample, and an rtl2832u fifo
      // overrun is not visible from here, so there is no honest count to give.
      dropped: 0,
    }
    this.ctx.emit(iq)

    const now = performance.now()
    if (now - this.lastFft < FFT_MIN_INTERVAL_MS) return
    if (n < FFT_SIZE * 2) return
    this.lastFft = now
    const frame: Omit<FftFrame, 'source' | 'seq' | 't' | 'wall'> = {
      kind: 'fft',
      bins: this.analyzer.process(samples).slice(),
      centerHz,
      sampleRate,
    }
    this.ctx.emit(frame)
  }
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

const descriptor: DeviceDescriptor = {
  kind: 'rtlsdr',
  name: 'RTL-SDR',
  blurb: 'a radio you can play with',
  icon: 'radio',
  transports: ['webusb'],
  capabilities: [
    CAPABILITIES.OBSERVE_SPECTRUM,
    CAPABILITIES.CAPTURE_IQ,
    CAPABILITIES.AUDIO_DEMOD,
  ],
  params: [
    {
      key: 'centerHz',
      label: 'center',
      unit: 'Hz',
      min: 24e6,
      max: 1766e6,
      step: 1000,
      default: 100.3e6,
      log: true,
    },
    {
      key: 'sampleRate',
      label: 'sample rate',
      unit: 'sps',
      min: 2048000,
      max: 3200000,
      choices: [2048000, 2400000, 3200000],
      default: 2400000,
    },
    { key: 'gain', label: 'gain', unit: 'dB', min: 0, max: 49, step: 1, default: 49 },
    { key: 'ppm', label: 'ppm', min: -100, max: 100, step: 1, default: 0 },
    { key: 'squelch', label: 'squelch', unit: 'dB', min: -100, max: 0, step: 1, default: -100 },
    { key: 'volume', label: 'volume', min: 0, max: 100, step: 1, default: 72 },
  ],
  usbFilters: USB_FILTERS,
  limits: {
    [CAPABILITIES.OBSERVE_SPECTRUM]:
      'tunes 24 mhz to 1.766 ghz. the r820t front end stops there, so 2.4 ghz work, wifi and ble included, cannot be done on this device.',
    [CAPABILITIES.CAPTURE_IQ]:
      'same 24 mhz to 1.766 ghz range, 8 bit samples, and about 2.4 msps before the usb link starts dropping them.',
    [CAPABILITIES.AUDIO_DEMOD]:
      'receive only, and one channel at a time within the tuned span. the dongle has no transmitter.',
  },
}

function usbId(d: USBDevice): string {
  return `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`
}

/**
 * Makers that rewrite the eeprom, Nooelec among them, leave a model name like
 * NESDR Mini 2 in the product string. The rest carry Realtek's part number.
 */
function labelFor(d: USBDevice): string {
  const product = d.productName?.trim() ?? ''
  return product && !GENERIC_PRODUCT.test(product) ? product : 'RTL-SDR'
}

function handleFor(port: UsbPort): DeviceHandle {
  const d = port.device
  return {
    kind: 'rtlsdr',
    transport: 'webusb',
    uid: port.serial || usbId(d),
    label: labelFor(d),
    raw: port,
  }
}

export const rtlsdrDriver: DeviceDriver = {
  descriptor,

  async requestAccess(transport: TransportKind): Promise<DeviceHandle | null> {
    if (transport !== 'webusb') throw new Error('rtl-sdr connects over webusb only')
    try {
      const port = await UsbPort.request(USB_FILTERS)
      return handleFor(port)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return null
      throw err
    }
  },

  async enumerate(): Promise<DeviceHandle[]> {
    if (typeof navigator === 'undefined' || !('usb' in navigator)) return []
    const ports = await UsbPort.paired(USB_FILTERS)
    return ports.map(handleFor)
  },

  async open(handle: DeviceHandle, ctx: DriverContext): Promise<DeviceSession> {
    const port = handle.raw as UsbPort
    const sdr = new RtlSdr(port)
    const defaults = Object.fromEntries(descriptor.params.map((p) => [p.key, p.default]))
    let rate: number
    let center: number
    try {
      await sdr.open(defaults.ppm)
      rate = await sdr.setSampleRate(defaults.sampleRate)
      await sdr.setGain(defaults.gain >= GAIN_AUTO_AT ? null : defaults.gain)
      center = await sdr.setCenterFrequency(defaults.centerHz)
    } catch (err) {
      // a claimed interface outlives a failed open, and the next connect
      // would be refused for it.
      await sdr.close().catch(() => undefined)
      throw err
    }

    const d = port.device
    const info: Record<string, string> = {
      tuner: sdr.tunerName,
      pll: sdr.tunerLocked ? 'locked' : 'no lock',
      serial: port.serial || 'none reported',
      maker: d.manufacturerName?.trim() || 'none reported',
      product: port.productName,
      usb: usbId(d),
      sampleRate: `${Math.round(rate)} sps`,
    }
    if (sdr.tuner && !sdr.tuner.calibrated) {
      info.filter = 'uncalibrated'
      ctx.log('tuner pll would not lock for filter calibration, running on the default filter')
    }
    ctx.setInfo(info)
    ctx.log(
      sdr.tunerLocked
        ? `${sdr.tunerName} tuner ready at ${Math.round(center)} hz`
        : `${sdr.tunerName} tuner pll did not lock at ${Math.round(center)} hz`,
    )

    return new RtlSession(sdr, ctx, info, defaults)
  },
}

/**
 * RTL-SDR driver: an RTL2832U demodulator with whichever tuner the stick
 * carries. librtlsdr supports six tuners, and so does this: the R820T family,
 * the R828D, the E4000, the FC0012, the FC0013 and the FC2580. The tuner is
 * probed at open, and the session reports the range and gains of the one found.
 *
 * Receive only. The dongle has no transmitter. Its bias tee gpio survives across
 * sessions and across other host applications, so reset clears it.
 */

import { CAPABILITIES } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import type {
  DeviceDescriptor,
  FftFrame,
  IqChunk,
  ParamSpec,
  TransportKind,
  UnitDescription,
} from '@/core/types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '@/core/drivers/types'
import { UsbPort } from '@/core/transport/webusb'
import { SpectrumAnalyzer } from '@/core/dsp/fft'
import { R82xx, R828D_XTAL } from './r82xx'
import type { R82xxModel } from './r82xx'
import { E4000 } from './e4000'
import { FC0012 } from './fc0012'
import { FC0013 } from './fc0013'
import { FC2580 } from './fc2580'
import type { Tuner, TunerHost } from './tuner'
import { BLOCK, IF_FREQ, REG, RTL_DEVICES, RtlCom, XTAL } from './rtlcom'
import type { RtlOp } from './rtlcom'

/** Bulk in endpoint carrying the 8 bit IQ stream. */
const IQ_ENDPOINT = 1

const XFER_BYTES = 16384
const XFER_DEPTH = 16

/** Spectrum frames past this rate are dropped rather than queued. */
const FFT_MIN_INTERVAL_MS = 1000 / 30

const FFT_SIZE = 2048

/** A transfer lands within milliseconds at every rate on offer, so this is dead. */
const STREAM_STALL_MS = 3000

const STALL_POLL_MS = 1000

/**
 * A hung dongle never completes its transfers and webusb cannot cancel them,
 * so teardown waits this long and then releases the interface, which does.
 */
const UNWIND_MS = 1000

function settle(p: Promise<void>): Promise<void> {
  return Promise.race([
    p.catch(() => undefined),
    new Promise<void>((r) => setTimeout(r, UNWIND_MS)),
  ])
}

const USB_FILTERS: USBDeviceFilter[] = RTL_DEVICES.map(([vendorId, productId]) => ({
  vendorId,
  productId,
}))

/** The product string Realtek burns in when the maker left the eeprom alone. */
const GENERIC_PRODUCT = /^rtl28\d\d/i

/**
 * Direct sampling feeds an adc straight from an hf input and lets the demod's
 * own oscillator tune, so it reaches from here up to the adc clock. Past half
 * the clock the band arrives mirrored.
 */
const HF_MIN = 500000
const HF_MAX = XTAL

/** librtlsdr's direct sampling modes. 1 is the i adc, 2 the q adc. */
const HF_OFF = 0
const HF_Q = 2

/** Every rate the RTL2832U resampler takes. librtlsdr refuses 300 k to 900 k. */
const RATES = [250000, 1024000, 1536000, 1800000, 2048000, 2400000, 2880000, 3200000]

/** Strings that mark a board with its hf input wired to the q adc. */
function hfWired(d: USBDevice): boolean {
  return (
    (d.manufacturerName === 'RTLSDRBlog' && d.productName === 'Blog V3') ||
    /^nesdr smart v5/i.test(d.productName ?? '')
  )
}

/** librtlsdr compares both strings exactly when it picks a board. */
function isBoard(d: USBDevice, product: string): boolean {
  return d.manufacturerName === 'RTLSDRBlog' && d.productName === product
}

type TunerKind = R82xxModel | 'e4000' | 'fc0012' | 'fc0013' | 'fc2580'

/**
 * What each Fitipower chip is rated to receive. Their plls program further
 * than this, down to about 13 MHz and up to 1.9 GHz, and librtlsdr accepts it,
 * but the front ends are not specified out there.
 */
const RATED: Partial<Record<TunerKind, [number, number]>> = {
  fc0012: [22e6, 948.6e6],
  fc0013: [22e6, 1100e6],
}

/** Keeps the parts of each span inside the rating. */
function within(spans: Array<[number, number]>, rated?: [number, number]): Array<[number, number]> {
  if (!rated) return spans
  return spans
    .map(([lo, hi]): [number, number] => [Math.max(lo, rated[0]), Math.min(hi, rated[1])])
    .filter(([lo, hi]) => hi > lo)
}

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
// ---------------------------------------------------------------------------
// hardware
// ---------------------------------------------------------------------------

class RtlSdr {
  readonly port: UsbPort
  readonly com: RtlCom
  tuner: Tuner | null = null
  kind: TunerKind | null = null
  ppm = 0
  rate = 0
  freq = 100000000
  /** 0 off, 1 the i adc, 2 the q adc, used below the tuner's range. */
  hf = HF_OFF
  /** True while the demod is sampling the hf input instead of the tuner. */
  direct = false
  biasTee = false
  /** The frequency asked for, before the pll rounds it. Null until the first tune. */
  private wantHz: number | null = null
  /** Tenths of a dB, or null for the tuner's agc. Reapplied when the tuner is reinitialised. */
  private gain: number | null = null
  /** False when the pll did not report lock at the last tune. */
  tunerLocked = true

  constructor(port: UsbPort) {
    this.port = port
    this.com = new RtlCom(port)
  }

  private correctedXtal(): number {
    return Math.floor(XTAL * (1 + this.ppm / 1e6))
  }

  /** A plain R828D has its own crystal, every other tuner runs from the RTL2832U's. */
  private tunerXtal(): number {
    const base = this.kind === 'r828d' ? R828D_XTAL : XTAL
    return Math.floor(base * (1 + this.ppm / 1e6))
  }

  private host(): TunerHost {
    return {
      com: this.com,
      xtal: this.tunerXtal(),
      setGpioOutput: (bit) => this.setGpioOutput(bit),
      setGpioBit: (bit, on) => this.setGpioBit(bit, on),
    }
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
      this.kind = await this.probe()
      if (!this.kind) {
        throw new Error(
          'no tuner answered on the i2c bus. unplug the dongle, plug it back in, and connect again.',
        )
      }
      this.tuner = this.makeTuner(this.kind)
      if (this.tuner.lowIf) {
        await com.writeEach([
          ['demod', 1, 0xb1, 0x1a, 1],
          ['demod', 0, 0x08, 0x4d, 1],
        ])
        await this.setIfFreq(IF_FREQ)
        await com.writeDemod(1, 0x15, 0x01, 1)
      }
      await this.tuner.init()
      // a bias tee left on by another program or a crashed tab outlives the
      // port, and the knob opens reading off.
      await this.clearBiasTee()
    } finally {
      try {
        await com.i2cClose()
      } catch {
        // on an unplugged device the gate close fails too, and the tuner
        // failure is the one the caller needs.
      }
    }
  }

  /** librtlsdr's probe order. The FC2580 and FC0012 answer only after a reset pulse on gpio 4. */
  private async probe(): Promise<TunerKind | null> {
    const com = this.com
    const d = this.port.device
    if ((await com.i2cProbe(0xc8, 0x02)) === 0x40) return 'e4000'
    if ((await com.i2cProbe(0xc6, 0x00)) === 0xa3) return 'fc0013'
    const r82 = await R82xx.detect(com)
    if (r82 === 'r820t') return isBoard(d, 'Blog V4L') ? 'blog-v4-lite' : 'r820t'
    if (r82 === 'r828d') return isBoard(d, 'Blog V4') ? 'blog-v4' : 'r828d'
    await this.setGpioOutput(4)
    await this.setGpioBit(4, true)
    await this.setGpioBit(4, false)
    const fc2580 = await com.i2cProbe(0xac, 0x01)
    if (fc2580 !== null && (fc2580 & 0x7f) === 0x56) return 'fc2580'
    if ((await com.i2cProbe(0xc6, 0x00)) === 0xa1) return 'fc0012'
    return null
  }

  private makeTuner(kind: TunerKind): Tuner {
    const host = this.host()
    switch (kind) {
      case 'e4000':
        return new E4000(host)
      case 'fc0012':
        return new FC0012(host)
      case 'fc0013':
        return new FC0013(host)
      case 'fc2580':
        return new FC2580(host)
      default:
        return new R82xx(host, kind)
    }
  }

  get tunerName(): string {
    return this.tuner?.name ?? 'none'
  }

  /** The Blog v4 boards reach hf through their own upconverter instead. */
  get hfCapable(): boolean {
    return this.kind !== 'blog-v4' && this.kind !== 'blog-v4-lite'
  }

  /** Every span the stick can tune with the current hf setting, lowest first. */
  /** The tuner's own spans, cut to its rating. */
  tunerRanges(): Array<[number, number]> {
    return within(this.tuner?.ranges ?? [], this.kind ? RATED[this.kind] : undefined)
  }

  ranges(): Array<[number, number]> {
    const tuned = this.tunerRanges()
    if (this.hf === HF_OFF || !this.hfCapable || !tuned.length) return tuned
    return [[HF_MIN, HF_MAX] as [number, number], ...tuned].reduce<Array<[number, number]>>(
      (out, r) => {
        const last = out[out.length - 1]
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
        else out.push([r[0], r[1]])
        return out
      },
      [],
    )
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

  private async gated<T>(fn: (t: Tuner) => Promise<T>): Promise<T> {
    if (!this.tuner) throw new Error('tuner is not initialised')
    const tuner = this.tuner
    await this.com.i2cOpen()
    try {
      return await fn(tuner)
    } finally {
      await this.com.i2cClose()
    }
  }

  /** Returns the rate the resampler actually lands on, which is what dsp uses. */
  async setSampleRate(rate: number): Promise<number> {
    // the ratio register is 28 bits with bit 27 acting as a sign, which is what
    // lets rates below about 450 k work at all.
    const ratio = Math.floor((XTAL * 4194304) / rate) & 0x0ffffffc
    const realRatio = ratio | ((ratio & 0x08000000) << 1)
    const real = (XTAL * 4194304) / realRatio
    this.rate = real
    // the resampler has to follow the rate even when the retune inside the
    // bandwidth step fails, or samples go out labelled with the wrong rate.
    let failed: unknown = null
    if (this.tuner && !this.direct) {
      try {
        await this.applyBandwidth()
      } catch (err) {
        failed = err
      }
    }
    const off = Math.trunc((-this.ppm * 16777216) / 1e6)
    await this.com.writeEach([
      ['demod', 1, 0x9f, (ratio >> 16) & 0xffff, 2],
      ['demod', 1, 0xa1, ratio & 0xffff, 2],
      ['demod', 1, 0x3e, (off >> 8) & 0x3f, 1],
      ['demod', 1, 0x3f, off & 0xff, 1],
      ['demod', 1, 0x01, 0x14, 1],
      ['demod', 1, 0x01, 0x10, 1],
    ])
    if (failed) throw failed
    return real
  }

  /** Fits the tuner's filter to the rate and moves the demod if with it, as librtlsdr's set_bw does. */
  private async applyBandwidth(): Promise<void> {
    const ifHz = await this.gated((t) => t.setBandwidth(Math.floor(this.rate)))
    if (ifHz !== null) await this.setIfFreq(ifHz)
    if (this.wantHz !== null) await this.setCenterFrequency(this.wantHz)
  }

  /**
   * Below the tuner's range on a stick with an hf input this switches to
   * direct sampling, and back above it, the way the RTL-SDR Blog driver does.
   */
  async setCenterFrequency(hz: number): Promise<number> {
    if (!this.tuner) throw new Error('tuner is not initialised')
    const ranges = this.ranges()
    if (!ranges.some(([lo, hi]) => hz >= lo && hz <= hi)) {
      const spans = ranges.map(([lo, hi]) => `${fmtMhz(lo)} to ${fmtMhz(hi)}`).join(', ')
      throw new Error(`the ${this.tunerName} cannot tune ${fmtMhz(hz)}. it covers ${spans}.`)
    }
    const wantDirect =
      this.hf !== HF_OFF && this.hfCapable && hz < this.tunerRanges()[0][0] && hz <= HF_MAX
    if (wantDirect !== this.direct) await this.setDirect(wantDirect)
    if (this.direct) {
      await this.setIfFreq(hz)
      this.wantHz = hz
      this.tunerLocked = true
      this.freq = hz
      return hz
    }
    const actual = await this.gated((t) => t.setFrequency(hz))
    this.tunerLocked = this.tuner.pllLock
    if (actual === null) throw new Error(`the ${this.tunerName} would not lock at ${fmtMhz(hz)}`)
    this.wantHz = hz
    this.freq = actual
    return actual
  }

  /** librtlsdr's set_direct_sampling, with the tuner's filter and gain put back on the way out. */
  private async setDirect(on: boolean): Promise<void> {
    const tuner = this.tuner
    if (!tuner) return
    if (on) {
      await this.gated((t) => t.shutdown())
      // the tuner is in standby from here, so a failure below must not leave
      // the next tune thinking it is live.
      this.direct = true
      await this.com.writeEach([
        ['demod', 1, 0xb1, 0x1a, 1],
        ['demod', 1, 0x15, 0x00, 1],
        ['demod', 0, 0x08, 0x4d, 1],
        ['demod', 0, 0x06, this.hf === HF_Q ? 0x90 : 0x80, 1],
      ])
      return
    }
    await this.gated((t) => t.init())
    if (tuner.lowIf) {
      await this.setIfFreq(IF_FREQ)
      await this.com.writeDemod(1, 0x15, 0x01, 1)
    } else {
      await this.setIfFreq(0)
      await this.com.writeEach([
        ['demod', 0, 0x08, 0xcd, 1],
        ['demod', 1, 0xb1, 0x1b, 1],
      ])
    }
    await this.com.writeDemod(0, 0x06, 0x80, 1)
    this.direct = false
    const want = this.wantHz
    this.wantHz = null
    try {
      await this.applyBandwidth()
    } finally {
      // init put the tuner back at its own gain, which the knob no longer shows.
      this.wantHz = want
      await this.setGain(this.gain)
    }
  }

  /** Changing which adc carries hf takes effect at once when it is already in use. */
  async setHf(mode: number): Promise<void> {
    if (mode === HF_OFF && this.direct) {
      throw new Error(`tune above ${fmtMhz(this.tunerRanges()[0]?.[0] ?? 0)} before turning hf off`)
    }
    this.hf = mode
    if (this.direct) await this.com.writeDemod(0, 0x06, mode === HF_Q ? 0x90 : 0x80, 1)
  }

  /**
   * The knob in dB to what the tuner is told. One past the top manual step is
   * the agc on a tuner that has one, and the rest snaps to the nearest step
   * librtlsdr lists.
   */
  gainFor(db: number): number | null {
    const gains = this.tuner?.gains ?? []
    if (!gains.length) return null
    const top = Math.ceil(gains[gains.length - 1] / 10)
    if (this.tuner?.agc && db > top) return null
    const want = db * 10
    return gains.reduce((best, g) => (Math.abs(g - want) < Math.abs(best - want) ? g : best))
  }

  async setGain(tenths: number | null): Promise<void> {
    this.gain = tenths
    if (this.direct || !this.tuner?.gains.length) return
    await this.gated((t) => t.setGain(tenths))
  }

  async setDigitalAgc(on: boolean): Promise<void> {
    await this.com.writeDemod(0, 0x19, on ? 0x25 : 0x05, 1)
  }

  /** The sample rate step retunes the if and the centre against the corrected crystal. */
  async setPpm(ppm: number): Promise<void> {
    this.ppm = ppm
    this.tuner?.setXtal(this.tunerXtal())
    await this.setSampleRate(this.rate)
    if (this.direct && this.wantHz !== null) await this.setIfFreq(this.wantHz)
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

  /** librtlsdr's bias tee, gpio 0 on every board that has one. */
  async setBiasTee(on: boolean): Promise<void> {
    await this.setGpioOutput(0)
    await this.setGpioBit(0, on)
    this.biasTee = on
  }

  /**
   * A pin nothing has made an output cannot be powering a bias tee, and on
   * boards without one gpio 0 may be an input, so it is left alone.
   */
  async clearBiasTee(): Promise<void> {
    this.biasTee = false
    const oe = await this.com.readReg(BLOCK.SYS, REG.GPOE, 1)
    if (!(oe & 1)) return
    await this.setGpioBit(0, false)
  }

  async resetBuffer(): Promise<void> {
    await this.com.writeEach([
      ['reg', BLOCK.USB, REG.EPA_CTL, 0x0210, 2],
      ['reg', BLOCK.USB, REG.EPA_CTL, 0x0000, 2],
    ])
  }

  /** The i2c gate and the demod power state outlive the port, so both are cleared here. */
  async close(): Promise<void> {
    // a refused claim usually means another program is streaming from this
    // dongle, and device control transfers would still reach it.
    if (!this.port.isOpen) {
      await this.port.release()
      return
    }
    if (this.tuner) {
      try {
        await this.gated((t) => t.shutdown())
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

function fmtMhz(hz: number): string {
  return `${Number((hz / 1e6).toFixed(3))} mhz`
}

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
  /** Two tools asking at once must share one stream. */
  private starting: Promise<void> | null = null
  private abort: AbortController | null = null
  private lastChunk = 0
  private stallMisses = 0
  private watchdog: ReturnType<typeof setInterval> | null = null
  private streamFailed = false
  /** Control transfers must not interleave, i2c least of all. */
  private queue: Promise<unknown> = Promise.resolve()
  private applied: Record<string, number> = {}

  private hfDefault: number

  constructor(
    sdr: RtlSdr,
    ctx: DriverContext,
    info: Record<string, string>,
    applied: Record<string, number>,
    hfDefault: number,
  ) {
    this.sdr = sdr
    this.ctx = ctx
    this.info = info
    this.applied = applied
    this.hfDefault = hfDefault
  }

  describe(): UnitDescription {
    return { params: paramsFor(this.sdr, this.hfDefault), limits: limitsFor(this.sdr) }
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

  /**
   * Runs one setting. A failure can leave the radio between the old value and
   * the new one, so what was applied before is no longer known, and the next
   * configure must send it again even though the panel shows it unchanged.
   */
  private async apply(keys: string[], fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch (err) {
      for (const k of keys) this.applied[k] = Number.NaN
      throw err
    }
  }

  async configure(params: Record<string, number>): Promise<void> {
    await this.serial(async () => {
      if (params.ppm !== undefined && params.ppm !== this.applied.ppm) {
        // a ppm change retunes, so the centre is in doubt when it fails too.
        await this.apply(['ppm', 'centerHz'], () => this.sdr.setPpm(params.ppm))
        this.applied.ppm = params.ppm
      }
      if (params.sampleRate !== undefined && params.sampleRate !== this.applied.sampleRate) {
        let real = 0
        await this.apply(['sampleRate', 'centerHz'], async () => {
          real = await this.sdr.setSampleRate(params.sampleRate)
        })
        this.applied.sampleRate = params.sampleRate
        this.info.sampleRate = `${Math.round(real)} sps`
        this.ctx.setInfo({ sampleRate: this.info.sampleRate })
      }
      const hfChange = params.hf !== undefined && params.hf !== this.applied.hf && this.sdr.hfCapable
      // turning hf off is refused below the tuner, so a retune in the same call goes first.
      const centreFirst = hfChange && params.hf === HF_OFF && this.sdr.direct
      if (hfChange && !centreFirst) {
        await this.sdr.setHf(params.hf)
        this.applied.hf = params.hf
      }
      if (params.centerHz !== undefined && params.centerHz !== this.applied.centerHz) {
        const wasDirect = this.sdr.direct
        await this.apply(['centerHz'], async () => {
          await this.sdr.setCenterFrequency(params.centerHz)
        })
        this.applied.centerHz = params.centerHz
        this.info.pll = this.sdr.direct ? 'direct sampling' : this.sdr.tunerLocked ? 'locked' : 'no lock'
        this.ctx.setInfo({ pll: this.info.pll })
        if (wasDirect !== this.sdr.direct) {
          this.ctx.log(this.sdr.direct ? 'below the tuner, sampling the hf input directly' : 'back on the tuner')
        }
        if (!this.sdr.tunerLocked) {
          this.ctx.log(`tuner pll did not lock at ${Math.round(params.centerHz)} hz`)
        }
      }
      if (centreFirst) {
        await this.sdr.setHf(params.hf)
        this.applied.hf = params.hf
      }
      if (params.gain !== undefined && params.gain !== this.applied.gain) {
        await this.apply(['gain'], () => this.sdr.setGain(this.sdr.gainFor(params.gain)))
        this.applied.gain = params.gain
      }
      if (params.biasTee !== undefined && params.biasTee !== this.applied.biasTee) {
        await this.sdr.setBiasTee(params.biasTee === 1)
        this.applied.biasTee = params.biasTee
        this.ctx.log(params.biasTee === 1 ? 'bias tee on, the antenna port now carries dc' : 'bias tee off')
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
    if (this.starting) return this.starting
    const starting = this.begin()
    this.starting = starting
    try {
      await starting
    } finally {
      if (this.starting === starting) this.starting = null
    }
  }

  private async begin(): Promise<void> {
    const abort = new AbortController()
    this.abort = abort
    this.ctx.signal.addEventListener('abort', () => abort.abort(), {
      once: true,
      signal: abort.signal,
    })

    const previous = this.pending
    this.pending = null
    if (previous) await settle(previous)

    await this.serial(() => this.sdr.resetBuffer())
    // a stop that landed during the awaits above has already aborted this.
    if (abort.signal.aborted) return
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
    if (pending) await settle(pending)
  }

  async resetToSafeState(): Promise<void> {
    await this.stop()
    try {
      await this.serial(() => this.sdr.clearBiasTee())
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

/**
 * The knobs for one stick. With no stick it describes the common R820T case,
 * which is what the connect list and the simulated twin show.
 */
/** Where a stick opens: FM broadcast if the tuner reaches it, else the reachable point nearest it. */
const HOME_HZ = 100.3e6

function homeFor(ranges: Array<[number, number]>): number {
  let best = HOME_HZ
  let gap = Infinity
  for (const [lo, hi] of ranges) {
    const at = Math.min(hi, Math.max(lo, HOME_HZ))
    if (Math.abs(at - HOME_HZ) < gap) {
      gap = Math.abs(at - HOME_HZ)
      best = at
    }
  }
  return best
}

function paramsFor(sdr: RtlSdr | null, hfDefault = HF_OFF): ParamSpec[] {
  const ranges = sdr?.ranges() ?? [[24e6, 1766e6]]
  const gains = sdr ? (sdr.tuner?.gains ?? []) : [0, 496]
  const params: ParamSpec[] = [
    {
      key: 'centerHz',
      label: 'center',
      unit: 'Hz',
      min: ranges[0][0],
      max: ranges[ranges.length - 1][1],
      step: 1000,
      default: homeFor(sdr?.tunerRanges() ?? ranges),
      log: true,
      spans: ranges.length > 1 ? ranges : undefined,
    },
    {
      key: 'sampleRate',
      label: 'sample rate',
      unit: 'sps',
      min: RATES[0],
      max: RATES[RATES.length - 1],
      choices: RATES,
      default: 2400000,
    },
  ]
  if (gains.length) {
    const top = Math.ceil(gains[gains.length - 1] / 10)
    const agc = sdr?.tuner?.agc ?? true
    // one past the top manual step hands gain to the tuner's agc, where there is one.
    params.push({
      key: 'gain',
      label: 'gain',
      unit: 'dB',
      min: Math.floor(gains[0] / 10),
      max: agc ? top + 1 : top,
      step: 1,
      default: agc ? top + 1 : top,
      topLabel: agc ? 'auto' : undefined,
    })
  }
  params.push({ key: 'ppm', label: 'ppm', min: -100, max: 100, step: 1, default: 0, remember: true })
  if (!sdr || sdr.hfCapable) {
    params.push({
      key: 'hf',
      label: 'hf input',
      min: 0,
      max: 2,
      choices: [HF_OFF, 1, HF_Q],
      choiceLabels: ['off', 'i adc', 'q adc'],
      default: hfDefault,
      remember: true,
    })
  }
  params.push(
    {
      key: 'biasTee',
      label: 'bias tee',
      min: 0,
      max: 1,
      choices: [0, 1],
      choiceLabels: ['off', 'on'],
      default: 0,
    },
    { key: 'squelch', label: 'squelch', unit: 'dB', min: -100, max: 0, step: 1, default: -100 },
    { key: 'volume', label: 'volume', min: 0, max: 100, step: 1, default: 72 },
  )
  return params
}

function limitsFor(sdr: RtlSdr | null): DeviceDescriptor['limits'] {
  const name = sdr?.tunerName ?? 'r820t'
  const spans = (sdr?.ranges() ?? [[24e6, 1766e6]])
    .map(([lo, hi]) => `${fmtMhz(lo)} to ${fmtMhz(hi)}`)
    .join(' and ')
  let hf = ''
  if (sdr && !sdr.hfCapable) {
    hf = ' below 28.8 mhz it switches to its upconverter and hf input on its own.'
  } else if (sdr?.hf) {
    hf = ` below ${fmtMhz(sdr.tunerRanges()[0]?.[0] ?? 24e6)} it samples the hf input directly. that only hears anything on a stick wired for it, like the rtl-sdr blog v3 or the nesdr smart v5.`
  } else {
    hf = ' hf below that needs direct sampling. set the hf input knob if this stick has an hf input.'
  }
  // librtlsdr runs this tuner from a fixed 16.384 mhz figure, so ppm only reaches the demod.
  const xtal = sdr?.kind === 'fc2580' ? ' the ppm knob corrects the demod only, the fc2580 runs on its own crystal.' : ''
  return {
    [CAPABILITIES.OBSERVE_SPECTRUM]: `the ${name} tunes ${spans}.${hf}${xtal} 2.4 ghz work, wifi and ble included, cannot be done on this device.`,
    [CAPABILITIES.CAPTURE_IQ]: `${spans}, 8 bit samples, and about 2.4 msps before the usb link starts dropping them.`,
    [CAPABILITIES.AUDIO_DEMOD]:
      'receive only, and one channel at a time within the tuned span. the dongle has no transmitter.',
  }
}

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
  params: paramsFor(null),
  usbFilters: USB_FILTERS,
  limits: limitsFor(null),
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
    const hfDefault = hfWired(port.device) ? HF_Q : HF_OFF
    let defaults: Record<string, number> = {}
    let rate: number
    let center: number
    try {
      await sdr.open(0)
      sdr.hf = sdr.hfCapable ? hfDefault : HF_OFF
      defaults = Object.fromEntries(paramsFor(sdr, hfDefault).map((p) => [p.key, p.default]))
      rate = await sdr.setSampleRate(defaults.sampleRate)
      await sdr.setGain(defaults.gain === undefined ? null : sdr.gainFor(defaults.gain))
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
    if (sdr.tuner instanceof R82xx && !sdr.tuner.calibrated) {
      info.filter = 'uncalibrated'
      ctx.log('tuner pll would not lock for filter calibration, running on the default filter')
    }
    ctx.setInfo(info)
    ctx.log(
      sdr.tunerLocked
        ? `${sdr.tunerName} tuner ready at ${Math.round(center)} hz`
        : `${sdr.tunerName} tuner pll did not lock at ${Math.round(center)} hz`,
    )

    return new RtlSession(sdr, ctx, info, defaults, hfDefault)
  },
}

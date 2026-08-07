/**
 * RTL-SDR driver: RTL2832U demodulator with an R820T or R828D tuner.
 *
 * Receive only. The dongle has no transmitter, so the only consequential thing
 * on it is the bias tee, which pushes dc up the coax.
 */

import { CAPABILITIES } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import type { DeviceDescriptor, FftFrame, IqChunk, TransportKind } from '@/core/types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '@/core/drivers/types'
import { UsbPort } from '@/core/transport/webusb'
import { SpectrumAnalyzer } from '@/core/dsp/fft'
import { R820T } from './r820t'
import { BLOCK, IF_FREQ, REG, RTL_VENDORS, RtlCom, XTAL } from './rtlcom'
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

const USB_FILTERS: USBDeviceFilter[] = RTL_VENDORS.map((vendorId) => ({ vendorId }))

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
  /** 0 is tuner path, 2 is direct sampling on the q branch. */
  direct = 0

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
    await this.port.claim({ configuration: 1, interface: 0 })
    await com.writeEach(INIT_OPS)

    await com.i2cOpen()
    const found = await R820T.detect(com)
    if (!found) {
      await com.i2cClose()
      throw new Error('no r820t or r828d tuner on this dongle, only that family is supported')
    }
    this.tuner = new R820T(com, this.correctedXtal())
    this.tunerName = 'r820t'
    await com.writeEach([
      ['demod', 1, 0xb1, 0x1a, 1],
      ['demod', 0, 0x08, 0x4d, 1],
    ])
    await this.setIfFreq(IF_FREQ)
    await com.writeDemod(1, 0x15, 0x01, 1)
    await this.tuner.init()
    await com.i2cClose()
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
    if (this.direct) {
      await this.setIfFreq(hz)
      this.freq = hz
      return hz
    }
    if (!this.tuner) throw new Error('tuner is not initialised')
    await this.com.i2cOpen()
    const actual = await this.tuner.setFrequency(hz + IF_FREQ)
    await this.com.i2cClose()
    this.freq = actual === null ? hz : actual - IF_FREQ
    return this.freq
  }

  async setGain(db: number | null): Promise<void> {
    if (!this.tuner) throw new Error('tuner is not initialised')
    await this.com.i2cOpen()
    if (db === null) await this.tuner.setAutoGain()
    else await this.tuner.setManualGain(db)
    await this.com.i2cClose()
  }

  async setDigitalAgc(on: boolean): Promise<void> {
    await this.com.writeDemod(0, 0x19, on ? 0x25 : 0x05, 1)
  }

  async setPpm(ppm: number): Promise<void> {
    this.ppm = ppm
    this.tuner?.setXtal(this.correctedXtal())
    if (!this.direct) await this.setIfFreq(IF_FREQ)
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

  async setDirectSampling(mode: number): Promise<void> {
    const com = this.com
    if (mode) {
      await com.i2cOpen()
      try {
        await this.tuner?.shutdown()
      } catch {
        // the tuner is being bypassed anyway, a failed shutdown does not block it.
      }
      await com.i2cClose()
      await com.writeEach([
        ['demod', 1, 0xb1, 0x1a, 1],
        ['demod', 1, 0x15, 0x00, 1],
        ['demod', 0, 0x08, 0x4d, 1],
        // q branch adc input.
        ['demod', 0, 0x06, 0x90, 1],
      ])
      this.direct = 2
    } else {
      this.direct = 0
      await com.i2cOpen()
      await this.tuner?.init()
      await com.i2cClose()
      await com.writeEach([
        ['demod', 1, 0xb1, 0x1a, 1],
        ['demod', 0, 0x08, 0x4d, 1],
      ])
      await this.setIfFreq(IF_FREQ)
      await com.writeEach([
        ['demod', 1, 0x15, 0x01, 1],
        ['demod', 0, 0x06, 0x80, 1],
      ])
    }
  }

  async resetBuffer(): Promise<void> {
    await this.com.writeEach([
      ['reg', BLOCK.USB, REG.EPA_CTL, 0x0210, 2],
      ['reg', BLOCK.USB, REG.EPA_CTL, 0x0000, 2],
    ])
  }

  async close(): Promise<void> {
    try {
      if (this.tuner && !this.direct) {
        await this.com.i2cOpen()
        await this.tuner.shutdown()
        await this.com.i2cClose()
      }
    } catch {
      // already unplugged. releasing the interface is still worth attempting.
    }
    await this.port.release()
  }
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

export interface RtlSdrSession extends DeviceSession {
  /** Pushes dc up the coax to feed an inline amplifier. */
  setBiasTee(on: boolean): Promise<void>
  /** 0 is the tuner path, non zero bypasses the tuner onto the q branch adc. */
  setDirectSampling(mode: number): Promise<void>
}

class RtlSession implements RtlSdrSession {
  private sdr: RtlSdr
  private ctx: DriverContext
  private info: Record<string, string>
  private analyzer = new SpectrumAnalyzer(FFT_SIZE)
  private lastFft = 0
  private dropped = 0
  private pumping: Promise<void> | null = null
  private abort: AbortController | null = null
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
        this.applied.ppm = params.ppm
        await this.sdr.setPpm(params.ppm)
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
        this.applied.centerHz = params.centerHz
        await this.sdr.setCenterFrequency(params.centerHz)
      }
      if (params.gain !== undefined && params.gain !== this.applied.gain) {
        this.applied.gain = params.gain
        await this.sdr.setGain(params.gain >= GAIN_AUTO_AT ? null : params.gain)
      }
    })
  }

  async start(mode: string): Promise<void> {
    if (mode !== 'iq') throw new Error(`rtl-sdr has no ${mode} mode, ask for iq`)
    if (this.pumping) return

    const abort = new AbortController()
    this.abort = abort
    this.ctx.signal.addEventListener('abort', () => abort.abort(), {
      once: true,
      signal: abort.signal,
    })

    await this.serial(() => this.sdr.resetBuffer())
    this.dropped = 0
    this.pumping = this.sdr.port.stream(
      IQ_ENDPOINT,
      XFER_BYTES,
      XFER_DEPTH,
      (chunk) => this.onChunk(chunk),
      abort.signal,
    )
    void this.pumping.catch((err: unknown) => {
      this.ctx.log(`usb read stopped: ${err instanceof Error ? err.message : String(err)}`)
    })
    this.ctx.log(`streaming iq at ${Math.round(this.sdr.rate)} sps`)
  }

  async stop(): Promise<void> {
    if (!this.abort) return
    this.abort.abort()
    this.abort = null
    const pending = this.pumping
    this.pumping = null
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
    return this.sdr.port.isOpen
  }

  async setBiasTee(on: boolean): Promise<void> {
    if (on && !this.ctx.isArmed(CAPABILITIES.POWER_SOURCE)) {
      throw new Error(
        'the bias tee sends dc up the coax. arm power out first, and check the antenna or splitter on the port can take it.',
      )
    }
    await this.serial(() => this.sdr.setBiasTee(on))
    this.ctx.log(`bias tee ${on ? 'on' : 'off'}`)
  }

  async setDirectSampling(mode: number): Promise<void> {
    await this.serial(async () => {
      await this.sdr.setDirectSampling(mode)
      if (!mode) {
        await this.sdr.setCenterFrequency(this.sdr.freq)
        await this.sdr.setGain(
          (this.applied.gain ?? GAIN_AUTO_AT) >= GAIN_AUTO_AT ? null : this.applied.gain,
        )
      }
    })
    this.ctx.log(mode ? 'direct sampling on the q branch, hf only' : 'tuner path')
  }

  /** 8 bit unsigned IQ pairs, offset binary around 127.5. */
  private onChunk(chunk: Uint8Array): void {
    if (chunk.length < XFER_BYTES) this.dropped++
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
      dropped: this.dropped,
    }
    this.dropped = 0
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

function handleFor(port: UsbPort): DeviceHandle {
  const d = port.device
  const id = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`
  return {
    kind: 'rtlsdr',
    transport: 'webusb',
    uid: port.serial || id,
    label: port.productName,
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
    await sdr.open(defaults.ppm)

    const rate = await sdr.setSampleRate(defaults.sampleRate)
    await sdr.setGain(defaults.gain >= GAIN_AUTO_AT ? null : defaults.gain)
    const center = await sdr.setCenterFrequency(defaults.centerHz)

    const info: Record<string, string> = {
      tuner: sdr.tunerName,
      serial: port.serial || 'none reported',
      product: port.productName,
      sampleRate: `${Math.round(rate)} sps`,
    }
    ctx.setInfo(info)
    ctx.log(`${sdr.tunerName} tuner ready at ${Math.round(center)} hz`)

    return new RtlSession(sdr, ctx, info, defaults)
  },
}

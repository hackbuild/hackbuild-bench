/**
 * Demodulators and the resampling they need. Input is interleaved IQ at the
 * device sample rate, output is mono audio at the audio context rate.
 */

export type DemodMode = 'fm' | 'nfm' | 'am' | 'usb' | 'lsb' | 'raw'

/**
 * Shifts a slice of the window down to baseband and decimates onto it, in one
 * pass over the samples.
 *
 * The mix is a recursive rotation rather than a trig call per sample, which
 * matters when the input is ten million samples a second. Rounding walks the
 * rotor off the unit circle, so it is renormalised periodically.
 */
export class Downconverter {
  private factor = 1
  private accI = 0
  private accQ = 0
  private count = 0
  private cos = 1
  private sin = 0
  private stepCos = 1
  private stepSin = 0
  private shifting = false
  private since = 0

  /** `offsetHz` is where in the window to listen, relative to its centre. */
  configure(factor: number, offsetHz: number, sampleRate: number): void {
    const next = Math.max(1, Math.floor(factor))
    if (next !== this.factor) {
      this.factor = next
      this.accI = this.accQ = this.count = 0
    }
    // mixing down by the offset puts the wanted signal at zero.
    const w = (-2 * Math.PI * offsetHz) / sampleRate
    this.stepCos = Math.cos(w)
    this.stepSin = Math.sin(w)
    this.shifting = offsetHz !== 0
    if (!this.shifting) {
      this.cos = 1
      this.sin = 0
    }
  }

  process(iq: Float32Array): Float32Array {
    if (!this.shifting && this.factor === 1) return iq
    const outLen = Math.floor(iq.length / 2 / this.factor) * 2
    const out = new Float32Array(outLen)
    let o = 0
    let c = this.cos
    let s = this.sin
    const sc = this.stepCos
    const ss = this.stepSin
    const shifting = this.shifting

    for (let i = 0; i < iq.length; i += 2) {
      let ri = iq[i]
      let rq = iq[i + 1]
      if (shifting) {
        const mi = ri * c - rq * s
        const mq = ri * s + rq * c
        ri = mi
        rq = mq
        const nc = c * sc - s * ss
        s = c * ss + s * sc
        c = nc
        if (++this.since >= 1024) {
          this.since = 0
          const n = Math.hypot(c, s) || 1
          c /= n
          s /= n
        }
      }
      this.accI += ri
      this.accQ += rq
      if (++this.count === this.factor) {
        if (o + 1 < outLen) {
          out[o++] = this.accI / this.factor
          out[o++] = this.accQ / this.factor
        }
        this.accI = this.accQ = this.count = 0
      }
    }
    this.cos = c
    this.sin = s
    return out.subarray(0, o)
  }
}

/** Quadrature FM discriminator. */
export class FmDemod {
  private lastI = 0
  private lastQ = 0
  private gain: number

  constructor(deviationHz = 75000, sampleRate = 240000) {
    this.gain = sampleRate / (2 * Math.PI * deviationHz)
  }

  configure(deviationHz: number, sampleRate: number): void {
    this.gain = sampleRate / (2 * Math.PI * deviationHz)
  }

  process(iq: Float32Array): Float32Array {
    const out = new Float32Array(iq.length / 2)
    for (let i = 0, o = 0; i < iq.length; i += 2, o++) {
      const ri = iq[i]
      const rq = iq[i + 1]
      // conjugate product with the previous sample gives the phase step.
      const di = ri * this.lastI + rq * this.lastQ
      const dq = rq * this.lastI - ri * this.lastQ
      out[o] = Math.atan2(dq, di) * this.gain
      this.lastI = ri
      this.lastQ = rq
    }
    return out
  }
}

/** Envelope detector with DC removal, which is what makes AM voice audible. */
export class AmDemod {
  private dc = 0

  process(iq: Float32Array): Float32Array {
    const out = new Float32Array(iq.length / 2)
    for (let i = 0, o = 0; i < iq.length; i += 2, o++) {
      const mag = Math.hypot(iq[i], iq[i + 1])
      this.dc = this.dc * 0.9995 + mag * 0.0005
      out[o] = mag - this.dc
    }
    return out
  }
}

/**
 * Single sideband by frequency shifting the wanted sideband to baseband and
 * taking the real part. Good enough for listening, not for measurement.
 */
export class SsbDemod {
  private phase = 0
  private readonly upper: boolean

  constructor(upper: boolean) {
    this.upper = upper
  }

  process(iq: Float32Array, sampleRate: number, bandwidthHz = 2700): Float32Array {
    const out = new Float32Array(iq.length / 2)
    const shift = (this.upper ? 1 : -1) * (bandwidthHz / 2)
    const step = (2 * Math.PI * shift) / sampleRate
    for (let i = 0, o = 0; i < iq.length; i += 2, o++) {
      const c = Math.cos(this.phase)
      const s = Math.sin(this.phase)
      out[o] = iq[i] * c - iq[i + 1] * s
      this.phase += step
      if (this.phase > Math.PI) this.phase -= 2 * Math.PI
      if (this.phase < -Math.PI) this.phase += 2 * Math.PI
    }
    return out
  }
}

/** One pole low pass, used as the audio de-emphasis and anti-alias stage. */
export class LowPass {
  private y = 0
  private a: number

  constructor(cutoffHz: number, sampleRate: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate)
  }

  configure(cutoffHz: number, sampleRate: number): void {
    this.a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate)
  }

  process(x: Float32Array): Float32Array {
    for (let i = 0; i < x.length; i++) {
      this.y += this.a * (x[i] - this.y)
      x[i] = this.y
    }
    return x
  }
}

/** Linear resampler to the audio context rate. */
export class Resampler {
  private pos = 0
  private last = 0

  process(input: Float32Array, ratio: number): Float32Array {
    const outLen = Math.floor(input.length / ratio)
    const out = new Float32Array(outLen)
    for (let o = 0; o < outLen; o++) {
      const src = this.pos + o * ratio
      const i = Math.floor(src)
      const frac = src - i
      const a = i === 0 ? this.last : (input[i - 1] ?? 0)
      const b = input[i] ?? a
      out[o] = a + (b - a) * frac
    }
    this.pos = (this.pos + outLen * ratio) % 1
    this.last = input[input.length - 1] ?? this.last
    return out
  }
}

/** Automatic gain so a quiet station and a strong one are both listenable. */
export class Agc {
  private gain = 1
  private target: number
  private attack: number
  private release: number

  constructor(target = 0.25, attack = 0.02, release = 0.0008) {
    this.target = target
    this.attack = attack
    this.release = release
  }

  process(x: Float32Array): Float32Array {
    let peak = 0
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i])
      if (a > peak) peak = a
    }
    if (peak > 1e-6) {
      const wanted = this.target / peak
      const rate = wanted < this.gain ? this.attack : this.release
      this.gain += (wanted - this.gain) * rate
    }
    this.gain = Math.min(this.gain, 80)
    for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i] * this.gain))
    return x
  }
}

/** Nothing useful survives a slice narrower than this. */
const MIN_BANDWIDTH = 500

/** What each mode listens through when nothing else is asked for. */
export const MODE_BANDWIDTH: Record<DemodMode, number> = {
  fm: 200000,
  nfm: 12500,
  am: 10000,
  usb: 2700,
  lsb: 2700,
  raw: 200000,
}

function clampRange(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * The full receive chain: shift, decimate, demodulate, filter, resample, level.
 * One instance per listening device.
 */
export class ReceiveChain {
  private down = new Downconverter()
  private fm = new FmDemod()
  private am = new AmDemod()
  private usb = new SsbDemod(true)
  private lsb = new SsbDemod(false)
  private lp: LowPass
  private resamp = new Resampler()
  private agc = new Agc()
  private mode: DemodMode = 'fm'
  private outRate = 48000
  private ifRate = 200000
  private inputRate = 0
  private offset = 0
  private bandwidth = MODE_BANDWIDTH.fm

  constructor(outRate = 48000) {
    this.outRate = outRate
    this.lp = new LowPass(8000, this.ifRate)
  }

  configure(mode: DemodMode, inputRate: number, bandwidthHz?: number): void {
    this.mode = mode
    this.inputRate = inputRate
    this.bandwidth = bandwidthHz ?? MODE_BANDWIDTH[mode]
    this.apply()
  }

  /** Where in the window to listen, in Hz from its centre. */
  setOffset(hz: number): void {
    this.offset = hz
    this.apply()
  }

  /** How wide a slice to keep. This is the passband the panel draws. */
  setBandwidth(hz: number): void {
    this.bandwidth = hz
    this.apply()
  }

  get offsetHz(): number {
    return this.offset
  }

  get bandwidthHz(): number {
    return this.bandwidth
  }

  /** How far off centre the offset may go before the passband leaves the window. */
  maxOffsetHz(): number {
    return Math.max(0, (this.inputRate - this.bandwidth) / 2)
  }

  /**
   * The decimation is the channel filter: what survives it is a slice one
   * bandwidth wide around the offset. Everything downstream runs at that rate.
   */
  private apply(): void {
    if (!this.inputRate) return
    this.bandwidth = clampRange(this.bandwidth, MIN_BANDWIDTH, this.inputRate)
    const limit = this.maxOffsetHz()
    this.offset = clampRange(this.offset, -limit, limit)

    const factor = Math.max(1, Math.round(this.inputRate / this.bandwidth))
    this.ifRate = this.inputRate / factor
    this.down.configure(factor, this.offset, this.inputRate)
    // deviation only sets the discriminator gain, and the agc follows it.
    const deviation = this.mode === 'fm' ? 75000 : Math.max(1000, this.bandwidth * 0.4)
    this.fm.configure(deviation, this.ifRate)
    const audioCut = Math.min(this.mode === 'fm' ? 15000 : 3400, this.ifRate * 0.45)
    this.lp.configure(audioCut, this.ifRate)
  }

  /** Interleaved IQ in, mono audio at outRate out. */
  process(iq: Float32Array): Float32Array {
    if (this.mode === 'raw') return new Float32Array(0)
    const base = this.down.process(iq)
    let audio: Float32Array
    switch (this.mode) {
      case 'fm':
      case 'nfm':
        audio = this.fm.process(base)
        break
      case 'am':
        audio = this.am.process(base)
        break
      case 'usb':
        audio = this.usb.process(base, this.ifRate)
        break
      case 'lsb':
        audio = this.lsb.process(base, this.ifRate)
        break
      default:
        return new Float32Array(0)
    }
    audio = this.lp.process(audio)
    audio = this.resamp.process(audio, this.ifRate / this.outRate)
    return this.agc.process(audio)
  }

  /** Wideband power in dB, used for the squelch and the sweep detector. */
  static power(iq: Float32Array): number {
    let sum = 0
    for (let i = 0; i < iq.length; i += 2) {
      sum += iq[i] * iq[i] + iq[i + 1] * iq[i + 1]
    }
    const mean = sum / (iq.length / 2)
    return 10 * Math.log10(mean + 1e-12)
  }
}

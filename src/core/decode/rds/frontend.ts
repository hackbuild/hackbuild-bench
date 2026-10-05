import { ComplexDecimator, lowPassTaps, tapsFor } from './fir'

/**
 * Wideband FM to the multiplex baseband: shift the listening point to zero,
 * filter one broadcast channel out of the window, and discriminate.
 *
 * The multiplex runs to 60 kHz plus deviation, so the channel keeps 100 kHz
 * either side and the output rate lands between 228 and 300 kHz whatever the
 * radio streams at. Two stages keep the filters short: a loose one down to
 * about 480 kHz, then the channel filter.
 */

/** Half the channel kept, in Hz. */
const CHANNEL_HZ = 100_000
/** Peak deviation of broadcast FM, which the output is scaled against. */
const DEVIATION_HZ = 75_000

export class FmMpx {
  private inputRate = 0
  private offsetHz = 0
  private stageA: ComplexDecimator | null = null
  private stageB: ComplexDecimator | null = null
  private cos = 1
  private sin = 0
  private stepCos = 1
  private stepSin = 0
  private since = 0
  private lastI = 0
  private lastQ = 0
  private gain = 1
  /** Rate of the multiplex this hands back. */
  rate = 0

  configure(inputRate: number, offsetHz: number): void {
    if (inputRate !== this.inputRate) {
      this.inputRate = inputRate
      const da = Math.max(1, Math.floor(inputRate / 480_000))
      const rateA = inputRate / da
      const db = Math.max(1, Math.floor(rateA / 228_000))
      this.rate = rateA / db
      // stage a only has to keep what would fold onto the channel after it.
      this.stageA =
        da > 1
          ? new ComplexDecimator(
              lowPassTaps(rateA / 2, inputRate, tapsFor(rateA - 2 * CHANNEL_HZ, inputRate, 63)),
              da,
            )
          : null
      this.stageB =
        db > 1
          ? new ComplexDecimator(
              lowPassTaps(this.rate / 2, rateA, tapsFor(this.rate - 2 * CHANNEL_HZ, rateA, 95)),
              db,
            )
          : null
      this.gain = this.rate / (2 * Math.PI * DEVIATION_HZ)
      this.lastI = this.lastQ = 0
    }
    this.offsetHz = offsetHz
    const w = (-2 * Math.PI * offsetHz) / inputRate
    this.stepCos = Math.cos(w)
    this.stepSin = Math.sin(w)
  }

  get offset(): number {
    return this.offsetHz
  }

  /** Interleaved IQ at the input rate in, multiplex at `rate` out. */
  process(iq: Float32Array): Float32Array {
    let x = iq
    if (this.offsetHz !== 0) x = this.shift(iq)
    if (this.stageA) x = this.stageA.process(x)
    if (this.stageB) x = this.stageB.process(x)
    const n = x.length >> 1
    const out = new Float32Array(n)
    let li = this.lastI
    let lq = this.lastQ
    const g = this.gain
    for (let k = 0; k < n; k++) {
      const i = x[2 * k]
      const q = x[2 * k + 1]
      out[k] = Math.atan2(q * li - i * lq, i * li + q * lq) * g
      li = i
      lq = q
    }
    this.lastI = li
    this.lastQ = lq
    return out
  }

  private shift(iq: Float32Array): Float32Array {
    const out = new Float32Array(iq.length)
    let c = this.cos
    let s = this.sin
    const sc = this.stepCos
    const ss = this.stepSin
    for (let k = 0; k < iq.length; k += 2) {
      const i = iq[k]
      const q = iq[k + 1]
      out[k] = i * c - q * s
      out[k + 1] = i * s + q * c
      const nc = c * sc - s * ss
      s = c * ss + s * sc
      c = nc
      if (++this.since >= 1024) {
        this.since = 0
        const m = Math.hypot(c, s) || 1
        c /= m
        s /= m
      }
    }
    this.cos = c
    this.sin = s
    return out
  }
}

/**
 * Pulls one narrow channel out of a wider IQ stream: a mixer to bring it to
 * zero, a windowed sinc low pass, and decimation by an integer to the lowest
 * rate at or above the one asked for.
 *
 * From a wide input the sinc alone would need more taps than are worth
 * running, so a boxcar average first brings the rate down to about four
 * times the output. Its first null then sits beyond anything that could
 * fold back onto the channel.
 */

/** Builds a low pass windowed sinc (blackman), normalised to unity gain at dc. */
export function lowPassTaps(cutoffHz: number, rate: number, count: number): Float32Array {
  const taps = new Float32Array(count)
  const mid = (count - 1) / 2
  const fc = cutoffHz / rate
  let sum = 0
  for (let i = 0; i < count; i++) {
    const x = i - mid
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (count - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (count - 1))
    taps[i] = sinc * w
    sum += taps[i]
  }
  for (let i = 0; i < count; i++) taps[i] /= sum
  return taps
}

export class ChannelFilter {
  private cos = 1
  private sin = 0
  private stepCos = 1
  private stepSin = 0
  private renorm = 0
  // history written twice so a window is always contiguous
  private readonly taps: Float32Array
  private readonly histI: Float32Array
  private readonly histQ: Float32Array
  private pos = 0
  private phase = 0
  private readonly rate: number
  private readonly pre: number
  private preN = 0
  private accI = 0
  private accQ = 0
  readonly decim: number
  /** Rate of the samples that come out. */
  readonly outRate: number
  outI = 0
  outQ = 0

  /**
   * @param offsetHz where the channel sits from the centre of the input
   * @param halfWidthHz the channel's half width, which is the filter's cutoff
   * @param minRate the lowest output rate acceptable
   */
  constructor(offsetHz: number, rate: number, halfWidthHz: number, minRate: number) {
    this.rate = rate
    this.retune(offsetHz)
    this.pre = rate / minRate > 8 ? Math.floor(rate / (4 * minRate)) : 1
    const inner = rate / this.pre
    this.decim = Math.max(1, Math.floor(inner / minRate))
    this.outRate = inner / this.decim
    const transition = Math.min(9000, this.outRate / 2 - halfWidthHz)
    let count = Math.ceil((5.5 * inner) / Math.max(2000, transition)) | 1
    count = Math.max(15, Math.min(255, count))
    this.taps = lowPassTaps(halfWidthHz, inner, count)
    this.histI = new Float32Array(count * 2)
    this.histQ = new Float32Array(count * 2)
  }

  /** Moves the mixer without disturbing the filter, for a slow frequency correction. */
  retune(offsetHz: number): void {
    const w = (-2 * Math.PI * offsetHz) / this.rate
    this.stepCos = Math.cos(w)
    this.stepSin = Math.sin(w)
  }

  /** True when an output sample is ready in outI and outQ. */
  push(i: number, q: number): boolean {
    let mi = i * this.cos - q * this.sin
    let mq = i * this.sin + q * this.cos
    const c = this.cos * this.stepCos - this.sin * this.stepSin
    this.sin = this.cos * this.stepSin + this.sin * this.stepCos
    this.cos = c
    if (++this.renorm === 4096) {
      this.renorm = 0
      const m = 1 / Math.hypot(this.cos, this.sin)
      this.cos *= m
      this.sin *= m
    }
    if (this.pre > 1) {
      this.accI += mi
      this.accQ += mq
      if (++this.preN < this.pre) return false
      mi = this.accI / this.pre
      mq = this.accQ / this.pre
      this.accI = 0
      this.accQ = 0
      this.preN = 0
    }

    const n = this.taps.length
    this.histI[this.pos] = mi
    this.histI[this.pos + n] = mi
    this.histQ[this.pos] = mq
    this.histQ[this.pos + n] = mq
    this.pos = this.pos + 1 === n ? 0 : this.pos + 1
    if (++this.phase < this.decim) return false
    this.phase = 0

    let fi = 0
    let fq = 0
    const t = this.taps
    for (let k = 0, h = this.pos; k < n; k++, h++) {
      fi += t[k] * this.histI[h]
      fq += t[k] * this.histQ[h]
    }
    this.outI = fi
    this.outQ = fq
    return true
  }
}

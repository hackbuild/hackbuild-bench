/**
 * Windowed sinc filters and the decimators the rds chain runs on.
 */

/** Low pass taps, unity gain at DC, Blackman window. */
export function lowPassTaps(cutoffHz: number, sampleRate: number, count: number): Float32Array {
  const n = count | 1
  const taps = new Float32Array(n)
  const fc = cutoffHz / sampleRate
  const mid = (n - 1) / 2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const x = i - mid
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
    const w =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1))
    taps[i] = sinc * w
    sum += taps[i]
  }
  for (let i = 0; i < n; i++) taps[i] /= sum
  return taps
}

/**
 * Tap count for a Blackman low pass with this transition width. Blackman
 * needs about 5.5 / width taps for its 74 dB of stopband.
 */
export function tapsFor(transitionHz: number, sampleRate: number, max = 255): number {
  const n = Math.ceil((5.5 * sampleRate) / Math.max(1, transitionHz))
  return Math.min(max, Math.max(5, n | 1))
}

/**
 * Complex FIR that keeps one output in `factor`. The history is stored twice
 * over, so every dot product reads one contiguous run.
 */
export class ComplexDecimator {
  private readonly taps: Float32Array
  private readonly n: number
  private readonly factor: number
  private readonly hi: Float32Array
  private readonly hq: Float32Array
  private pos = 0
  private phase = 0

  constructor(taps: Float32Array, factor: number) {
    this.taps = taps
    this.n = taps.length
    this.factor = Math.max(1, Math.floor(factor))
    this.hi = new Float32Array(this.n * 2)
    this.hq = new Float32Array(this.n * 2)
  }

  /** Interleaved IQ in, interleaved IQ out at the lower rate. */
  process(iq: Float32Array): Float32Array {
    const n = this.n
    const taps = this.taps
    const hi = this.hi
    const hq = this.hq
    const f = this.factor
    const count = iq.length >> 1
    const out = new Float32Array(Math.ceil((count + this.phase + 1) / f) * 2)
    let o = 0
    let pos = this.pos
    let phase = this.phase
    for (let k = 0; k < count; k++) {
      const i = iq[2 * k]
      const q = iq[2 * k + 1]
      hi[pos] = i
      hi[pos + n] = i
      hq[pos] = q
      hq[pos + n] = q
      pos = pos + 1 === n ? 0 : pos + 1
      if (++phase >= f) {
        phase = 0
        // pos is now the oldest sample, so the run pos..pos+n is time ordered.
        let ai = 0
        let aq = 0
        for (let t = 0; t < n; t++) {
          const c = taps[t]
          ai += c * hi[pos + t]
          aq += c * hq[pos + t]
        }
        out[o++] = ai
        out[o++] = aq
      }
    }
    this.pos = pos
    this.phase = phase
    return out.subarray(0, o)
  }
}

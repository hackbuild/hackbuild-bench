import { ComplexDecimator, lowPassTaps, tapsFor } from './fir'

/**
 * The 57 kHz subcarrier to data bits.
 *
 * RDS is BPSK at 2375 symbols a second, where each data bit is two opposite
 * half symbols (biphase) and the bits are differentially coded. The chain
 * brings the subcarrier to zero, filters it to the RDS band, recovers the
 * symbol clock with a Gardner detector and the carrier phase from the symbol
 * decisions, pairs the half symbols into bits, and undoes the differential
 * coding. The differential coding is what makes the 180 degree ambiguity of
 * a BPSK phase loop harmless.
 */

export const RDS_CARRIER_HZ = 57_000
export const RDS_BIT_RATE = 1187.5
const HALF_RATE = RDS_BIT_RATE * 2

/** The RDS band reaches 2.4 kHz either side, the stereo difference starts at 4. */
const PASS_HZ = 2_600
const STOP_HZ = 4_000
const HISTORY = 64
/**
 * Carrier loop noise bandwidth. Wider follows the phase wander that multipath
 * puts on a real station, narrower rejects more noise on a weak one.
 */
const LOOP_HZ = 12
/** The subcarrier is locked to the pilot, so the loop never has to pull far. */
const MAX_PULL_HZ = 30
/** Gardner step, as a share of a half symbol per unit of normalised error. */
const CLOCK_GAIN = 0.03

/**
 * The receive half of the RDS pulse shaping, IEC 62106 section 4.5: a
 * spectrum of cos(pi f td / 4) out to 2 / td. With the matching transmit
 * half, a half symbol comes out as a raised cosine pulse with no
 * interference at the neighbouring half symbol instants.
 */
function matchedFilter(rate: number): Float32Array {
  const td = 1 / RDS_BIT_RATE
  const band = 2 / td
  const half = Math.ceil(rate * td * 1.5)
  const taps = new Float32Array(half * 2 + 1)
  const steps = 64
  let peak = 0
  for (let n = -half; n <= half; n++) {
    const t = n / rate
    let acc = 0
    for (let k = 0; k < steps; k++) {
      const f = ((k + 0.5) * band) / steps
      acc += Math.cos((Math.PI * f * td) / 4) * Math.cos(2 * Math.PI * f * t)
    }
    const w = 0.5 + 0.5 * Math.cos((Math.PI * n) / (half + 1))
    taps[n + half] = acc * w
    peak = Math.max(peak, Math.abs(acc))
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= peak
  return taps
}

export interface RdsDemodState {
  /** 0 to 1, how much stronger the chosen half symbol pairing is than the other. */
  quality: number
  /** Carrier frequency error the loop is tracking, in Hz. */
  carrierErrorHz: number
}

export class RdsDemod {
  readonly inputRate: number
  /** Rate the loops run at. */
  readonly rate: number
  private readonly c1: ComplexDecimator
  private readonly c2: ComplexDecimator
  private readonly ncoStepCos: number
  private readonly ncoStepSin: number
  private ncoCos = 1
  private ncoSin = 0
  private ncoSince = 0

  // carrier loop, updated once a half symbol
  private theta = 0
  /** Phase advance per sample. */
  private omega = 0
  private readonly alpha: number
  private readonly beta: number

  // matched filter, history stored twice over for one contiguous read
  private readonly mf: Float32Array
  private readonly mfRe: Float32Array
  private readonly mfIm: Float32Array
  private mfPos = 0

  // symbol clock
  private readonly ts: number
  private readonly histRe = new Float32Array(HISTORY)
  private readonly histIm = new Float32Array(HISTORY)
  private n = 0
  private nextEnd: number
  private lastEnd = 0
  private amp = 1e-6

  // half symbol pairing
  private prevHalf = 0
  private halfIndex = 0
  private readonly pairScore = [0, 0]
  private lastBit = 0

  /** Each recovered data bit, after differential decoding. */
  onBit: (bit: number) => void = () => {}

  constructor(inputRate: number) {
    this.inputRate = inputRate
    const d1 = Math.max(1, Math.floor(inputRate / 48_000))
    const r1 = inputRate / d1
    const d2 = Math.max(1, Math.floor(r1 / 19_000))
    this.rate = r1 / d2
    this.c1 = new ComplexDecimator(
      lowPassTaps((PASS_HZ + r1 - STOP_HZ) / 2, inputRate, tapsFor(r1 - STOP_HZ - PASS_HZ, inputRate, 63)),
      d1,
    )
    this.c2 = new ComplexDecimator(
      lowPassTaps((PASS_HZ + STOP_HZ) / 2, r1, tapsFor(STOP_HZ - PASS_HZ, r1, 255)),
      d2,
    )
    const w = (-2 * Math.PI * RDS_CARRIER_HZ) / inputRate
    this.ncoStepCos = Math.cos(w)
    this.ncoStepSin = Math.sin(w)

    // second order loop, critically damped, stepped at the half symbol rate.
    const zeta = Math.SQRT1_2
    const tn = LOOP_HZ / HALF_RATE / (zeta + 1 / (4 * zeta))
    const den = 1 + 2 * zeta * tn + tn * tn
    this.alpha = (4 * zeta * tn) / den
    this.beta = (4 * tn * tn) / den

    this.ts = this.rate / HALF_RATE
    this.mf = matchedFilter(this.rate)
    this.mfRe = new Float32Array(this.mf.length * 2)
    this.mfIm = new Float32Array(this.mf.length * 2)
    this.nextEnd = this.ts * 2
  }

  get state(): RdsDemodState {
    const a = this.pairScore[0]
    const b = this.pairScore[1]
    const hi = Math.max(a, b)
    const lo = Math.min(a, b)
    return {
      quality: hi > 0 ? 1 - lo / hi : 0,
      carrierErrorHz: (this.omega * this.rate) / (2 * Math.PI),
    }
  }

  /** Multiplex samples at `inputRate`. */
  process(mpx: Float32Array): void {
    const mixed = new Float32Array(mpx.length * 2)
    let c = this.ncoCos
    let s = this.ncoSin
    const sc = this.ncoStepCos
    const ss = this.ncoStepSin
    for (let k = 0; k < mpx.length; k++) {
      mixed[2 * k] = mpx[k] * c
      mixed[2 * k + 1] = mpx[k] * s
      const nc = c * sc - s * ss
      s = c * ss + s * sc
      c = nc
      if (++this.ncoSince >= 1024) {
        this.ncoSince = 0
        const m = Math.hypot(c, s) || 1
        c /= m
        s /= m
      }
    }
    this.ncoCos = c
    this.ncoSin = s
    const base = this.c2.process(this.c1.process(mixed))
    for (let k = 0; k < base.length; k += 2) this.step(base[k], base[k + 1])
  }

  private step(i: number, q: number): void {
    const cs = Math.cos(this.theta)
    const sn = Math.sin(this.theta)
    const ri = i * cs + q * sn
    const rq = q * cs - i * sn
    this.theta += this.omega
    if (this.theta > Math.PI) this.theta -= 2 * Math.PI
    else if (this.theta < -Math.PI) this.theta += 2 * Math.PI

    const taps = this.mf
    const len = taps.length
    const p = this.mfPos
    this.mfRe[p] = this.mfRe[p + len] = ri
    this.mfIm[p] = this.mfIm[p + len] = rq
    const start = p + 1 === len ? 0 : p + 1
    this.mfPos = start
    let zr = 0
    let zi = 0
    for (let k = 0; k < len; k++) {
      zr += taps[k] * this.mfRe[start + k]
      zi += taps[k] * this.mfIm[start + k]
    }

    const h = this.n % HISTORY
    this.histRe[h] = zr
    this.histIm[h] = zi
    this.n++

    while (this.nextEnd <= this.n - 2) this.symbol()
  }

  private at(hist: Float32Array, t: number): number {
    const k = Math.floor(t)
    const f = t - k
    const a = hist[((k % HISTORY) + HISTORY) % HISTORY]
    const b = hist[(((k + 1) % HISTORY) + HISTORY) % HISTORY]
    return a + (b - a) * f
  }

  private symbol(): void {
    const t = this.nextEnd
    const end = this.at(this.histRe, t)
    const endIm = this.at(this.histIm, t)
    const mid = this.at(this.histRe, t - this.ts / 2)
    this.amp += (Math.hypot(end, endIm) - this.amp) * 0.01
    const norm = this.amp + 1e-20

    // decision directed bpsk phase error, the quadrature part against the
    // sign of the in phase part.
    const pe = Math.max(-1, Math.min(1, ((end >= 0 ? endIm : -endIm) / norm)))
    const limit = (2 * Math.PI * MAX_PULL_HZ) / this.rate
    this.omega = Math.max(-limit, Math.min(limit, this.omega + (this.beta * pe) / this.ts))
    this.theta += this.alpha * pe

    // gardner: a sample taken late puts mid past the zero crossing, against the step.
    const e = (mid * (this.lastEnd - end)) / (norm * norm)
    const adj = Math.max(-0.5, Math.min(0.5, e)) * this.ts * CLOCK_GAIN
    this.lastEnd = end
    this.nextEnd = t + this.ts + adj

    // a data bit is two opposite half symbols. which of the two pairings is
    // the real one shows as the larger difference across the pair.
    const diff = this.prevHalf - end
    const parity = this.halfIndex & 1
    this.pairScore[parity] = this.pairScore[parity] * 0.98 + Math.abs(diff) / norm
    this.halfIndex++
    this.prevHalf = end
    const chosen = this.pairScore[0] >= this.pairScore[1] ? 0 : 1
    if (parity !== chosen) return

    const bit = diff > 0 ? 1 : 0
    const data = bit ^ this.lastBit
    this.lastBit = bit
    this.onBit(data)
  }
}

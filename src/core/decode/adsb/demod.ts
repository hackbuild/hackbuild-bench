import { Score } from './message'

/**
 * Mode S pulse position demodulation from IQ.
 *
 * A Mode S reply is an 8 microsecond preamble of four 0.5 us pulses, then 56
 * or 112 bits of 1 us each, where a 1 is a pulse in the first half and a 0 in
 * the second. Only the envelope matters, so the IQ becomes magnitude first.
 *
 * Two sample rates are handled, the two dump1090 has demodulators for:
 *
 * - 2.4 Msps, six samples per five half bits. The half bit boundaries drift
 *   through the samples in fifths, so each preamble is tried at five phase
 *   offsets with correlators matched to each offset, and the frame that
 *   scores best wins. This follows dump1090-fa's demod_2400.c, and it is the
 *   rate the panel tunes, since an RTL-SDR has no exact 2 Msps.
 * - 2 Msps, one sample per half bit, for recordings such as dump1090's own
 *   test file. A frame that fails as sampled is retried once with the
 *   neighbouring sample's leakage scaled back out, as dump1090 does.
 */

export type DemodRate = 2_000_000 | 2_400_000

export interface DemodFrame {
  /** 14 bytes. A short frame uses the first 7. */
  raw: Uint8Array
  score: Score
  /** Sample index of the preamble start since the demodulator was created. */
  sample: number
  /** Mean power of the frame's samples, in dB relative to full scale. */
  signalDb: number
}

export type FrameScorer = (raw: Uint8Array) => Score

function dfSet(df: number, damage: number): number {
  let r = 1 << df
  if (!damage) return r >>> 0
  for (let b = 0; b < 5; b++) r |= dfSet(df ^ (1 << b), damage - 1)
  return r >>> 0
}

const VALID_SHORT = ((1 << 0) | (1 << 4) | (1 << 5) | (1 << 11) | dfSet(11, 1)) >>> 0
const VALID_LONG =
  ((1 << 16) | (1 << 17) | (1 << 18) | (1 << 20) | (1 << 21) | dfSet(17, 1) | dfSet(18, 1)) >>> 0

/** Samples kept from one block to the next, so a frame across the seam still decodes. */
const OVERLAP_2400 = 19 + 2 + 270
const OVERLAP_2000 = 1 + 16 + 224

// correlators for one manchester bit starting at each fifth of a sample. each
// sums to zero, so a dc offset in the magnitude cancels out.
function s0(m: Float32Array, i: number): number {
  return 5 * m[i] - 3 * m[i + 1] - 2 * m[i + 2]
}
function s1(m: Float32Array, i: number): number {
  return 4 * m[i] - m[i + 1] - 3 * m[i + 2]
}
function s2(m: Float32Array, i: number): number {
  return 3 * m[i] + m[i + 1] - 4 * m[i + 2]
}
function s3(m: Float32Array, i: number): number {
  return 2 * m[i] + 3 * m[i + 1] - 5 * m[i + 2]
}
function s4(m: Float32Array, i: number): number {
  return m[i] + 5 * m[i + 1] - 5 * m[i + 2] - m[i + 3]
}

export class ModeSDemod {
  readonly rate: DemodRate
  /** Preambles that passed the shape test, a measure of how busy the band is. */
  preambles = 0

  private mag: Float32Array
  private held = 0
  /** Absolute index of mag[0]. */
  private base = 0
  /** Where scanning resumes in mag, past the end of the last frame. */
  private resume = 0
  private readonly overlap: number
  private readonly score: FrameScorer
  private readonly onFrame: (f: DemodFrame) => void
  private bufA = new Uint8Array(14)
  private bufB = new Uint8Array(14)
  private scratch = new Float32Array(OVERLAP_2000 + 4)
  private dcI = 0
  private dcQ = 0
  private dcPrimed = false
  private best: Uint8Array = this.bufA
  private bestScore: Score = Score.NotSet

  constructor(rate: DemodRate, score: FrameScorer, onFrame: (f: DemodFrame) => void) {
    this.rate = rate
    this.score = score
    this.onFrame = onFrame
    this.overlap = rate === 2_400_000 ? OVERLAP_2400 : OVERLAP_2000
    this.mag = new Float32Array(16384 + this.overlap)
  }

  /** Samples taken in so far, for clocks that run on the sample count. */
  get samples(): number {
    return this.base + this.held
  }

  /** Forget the held tail, after a gap in the stream. */
  reset(): void {
    this.base += this.held
    this.held = 0
    this.resume = 0
  }

  /** Interleaved IQ as floats in about -1..1. */
  feed(iq: Float32Array): void {
    const n = iq.length >> 1
    if (this.held + n > this.mag.length) {
      const next = new Float32Array(this.held + n + this.overlap)
      next.set(this.mag.subarray(0, this.held))
      this.mag = next
    }
    const m = this.mag
    let o = this.held
    // an rtl-sdr's converter sits about a tenth of a step below its nominal
    // midpoint. left in, that offset flips the close comparisons the preamble
    // test makes, so the slow mean of i and q comes out first.
    let sumI = 0
    let sumQ = 0
    for (let i = 0; i < iq.length; i += 2) {
      sumI += iq[i]
      sumQ += iq[i + 1]
    }
    if (n) {
      const mi = sumI / n
      const mq = sumQ / n
      if (!this.dcPrimed) {
        this.dcI = mi
        this.dcQ = mq
        this.dcPrimed = true
      } else {
        this.dcI += (mi - this.dcI) * 0.1
        this.dcQ += (mq - this.dcQ) * 0.1
      }
    }
    const di = this.dcI
    const dq = this.dcQ
    for (let i = 0; i < iq.length; i += 2) {
      const a = iq[i] - di
      const b = iq[i + 1] - dq
      m[o++] = Math.sqrt(a * a + b * b)
    }
    this.held = o
    const end = this.held - this.overlap
    if (end <= 0) return
    if (this.rate === 2_400_000) this.scan2400(end)
    else this.scan2000(end)

    m.copyWithin(0, end, this.held)
    this.base += end
    this.held -= end
    this.resume = Math.max(0, this.resume - end)
  }

  private emit(raw: Uint8Array, score: Score, j: number, from: number, len: number): void {
    const m = this.mag
    let p = 0
    for (let k = 0; k < len; k++) p += m[from + k] * m[from + k]
    const signalDb = 10 * Math.log10(p / len + 1e-12)
    this.onFrame({ raw: raw.slice(), score, sample: this.base + j, signalDb })
  }

  private scan2400(end: number): void {
    const m = this.mag
    for (let j = this.resume; j < end; j++) {
      const p = j
      if (!(m[p] < m[p + 1] && m[p + 12] > m[p + 13])) continue

      let high: number
      let sig: number
      let noise: number
      if (
        m[p + 1] > m[p + 2] && m[p + 2] < m[p + 3] && m[p + 3] > m[p + 4] &&
        m[p + 8] < m[p + 9] && m[p + 9] > m[p + 10] && m[p + 10] < m[p + 11]
      ) {
        high = (m[p + 1] + m[p + 3] + m[p + 9] + m[p + 11] + m[p + 12]) / 4
        sig = m[p + 1] + m[p + 3] + m[p + 9]
        noise = m[p + 5] + m[p + 6] + m[p + 7]
      } else if (
        m[p + 1] > m[p + 2] && m[p + 2] < m[p + 3] && m[p + 3] > m[p + 4] &&
        m[p + 8] < m[p + 9] && m[p + 9] > m[p + 10] && m[p + 11] < m[p + 12]
      ) {
        high = (m[p + 1] + m[p + 3] + m[p + 9] + m[p + 12]) / 4
        sig = m[p + 1] + m[p + 3] + m[p + 9] + m[p + 12]
        noise = m[p + 5] + m[p + 6] + m[p + 7] + m[p + 8]
      } else if (
        m[p + 1] > m[p + 2] && m[p + 2] < m[p + 3] && m[p + 4] > m[p + 5] &&
        m[p + 8] < m[p + 9] && m[p + 10] > m[p + 11] && m[p + 11] < m[p + 12]
      ) {
        high = (m[p + 1] + m[p + 3] + m[p + 4] + m[p + 9] + m[p + 10] + m[p + 12]) / 4
        sig = m[p + 1] + m[p + 12]
        noise = m[p + 6] + m[p + 7]
      } else if (
        m[p + 1] > m[p + 2] && m[p + 3] < m[p + 4] && m[p + 4] > m[p + 5] &&
        m[p + 9] < m[p + 10] && m[p + 10] > m[p + 11] && m[p + 11] < m[p + 12]
      ) {
        high = (m[p + 1] + m[p + 4] + m[p + 10] + m[p + 12]) / 4
        sig = m[p + 1] + m[p + 4] + m[p + 10] + m[p + 12]
        noise = m[p + 5] + m[p + 6] + m[p + 7] + m[p + 8]
      } else if (
        m[p + 2] > m[p + 3] && m[p + 3] < m[p + 4] && m[p + 4] > m[p + 5] &&
        m[p + 9] < m[p + 10] && m[p + 10] > m[p + 11] && m[p + 11] < m[p + 12]
      ) {
        high = (m[p + 1] + m[p + 2] + m[p + 4] + m[p + 10] + m[p + 12]) / 4
        sig = m[p + 4] + m[p + 10] + m[p + 12]
        noise = m[p + 6] + m[p + 7] + m[p + 8]
      } else {
        continue
      }

      // about 3.5 dB between the pulses and the gaps between them.
      if (sig * 2 < 3 * noise) continue
      if (
        m[p + 5] >= high || m[p + 6] >= high || m[p + 7] >= high || m[p + 8] >= high ||
        m[p + 14] >= high || m[p + 15] >= high || m[p + 16] >= high ||
        m[p + 17] >= high || m[p + 18] >= high
      ) {
        continue
      }

      this.preambles++
      const len = this.bestOf2400(j)
      if (!len) continue

      const bits = len * 8
      this.emit(this.best, this.bestScore, j, j + 19, Math.floor((bits * 12) / 5))
      // resume 8 bits before the end, since the next preamble can overwrite
      // the tail of this frame without touching its data bits.
      const msgEnd = j + Math.floor(((bits + 8) * 12) / 5)
      this.resume = msgEnd
      j = msgEnd - Math.floor((8 * 12) / 5)
    }
  }

  /**
   * Slices the frame after a preamble at all five phase offsets and keeps the
   * best scoring one in this.best. Returns its length in bytes, or 0.
   */
  private bestOf2400(j: number): number {
    const m = this.mag
    let best: Uint8Array | null = null
    let bestLen = 0
    let bestScore: Score = Score.NotSet
    let msg = this.bufA
    for (let tryPhase = 4; tryPhase <= 8; tryPhase++) {
      let ptr = j + 19 + Math.floor(tryPhase / 5)
      let phase = tryPhase % 5
      let len = 1
      for (let i = 0; i < len; i++) {
        let b = 0
        switch (phase) {
          case 0:
            b =
              (s0(m, ptr) > 0 ? 0x80 : 0) | (s2(m, ptr + 2) > 0 ? 0x40 : 0) |
              (s4(m, ptr + 4) > 0 ? 0x20 : 0) | (s1(m, ptr + 7) > 0 ? 0x10 : 0) |
              (s3(m, ptr + 9) > 0 ? 0x08 : 0) | (s0(m, ptr + 12) > 0 ? 0x04 : 0) |
              (s2(m, ptr + 14) > 0 ? 0x02 : 0) | (s4(m, ptr + 16) > 0 ? 0x01 : 0)
            phase = 1
            ptr += 19
            break
          case 1:
            b =
              (s1(m, ptr) > 0 ? 0x80 : 0) | (s3(m, ptr + 2) > 0 ? 0x40 : 0) |
              (s0(m, ptr + 5) > 0 ? 0x20 : 0) | (s2(m, ptr + 7) > 0 ? 0x10 : 0) |
              (s4(m, ptr + 9) > 0 ? 0x08 : 0) | (s1(m, ptr + 12) > 0 ? 0x04 : 0) |
              (s3(m, ptr + 14) > 0 ? 0x02 : 0) | (s0(m, ptr + 17) > 0 ? 0x01 : 0)
            phase = 2
            ptr += 19
            break
          case 2:
            b =
              (s2(m, ptr) > 0 ? 0x80 : 0) | (s4(m, ptr + 2) > 0 ? 0x40 : 0) |
              (s1(m, ptr + 5) > 0 ? 0x20 : 0) | (s3(m, ptr + 7) > 0 ? 0x10 : 0) |
              (s0(m, ptr + 10) > 0 ? 0x08 : 0) | (s2(m, ptr + 12) > 0 ? 0x04 : 0) |
              (s4(m, ptr + 14) > 0 ? 0x02 : 0) | (s1(m, ptr + 17) > 0 ? 0x01 : 0)
            phase = 3
            ptr += 19
            break
          case 3:
            b =
              (s3(m, ptr) > 0 ? 0x80 : 0) | (s0(m, ptr + 3) > 0 ? 0x40 : 0) |
              (s2(m, ptr + 5) > 0 ? 0x20 : 0) | (s4(m, ptr + 7) > 0 ? 0x10 : 0) |
              (s1(m, ptr + 10) > 0 ? 0x08 : 0) | (s3(m, ptr + 12) > 0 ? 0x04 : 0) |
              (s0(m, ptr + 15) > 0 ? 0x02 : 0) | (s2(m, ptr + 17) > 0 ? 0x01 : 0)
            phase = 4
            ptr += 19
            break
          default:
            b =
              (s4(m, ptr) > 0 ? 0x80 : 0) | (s1(m, ptr + 3) > 0 ? 0x40 : 0) |
              (s3(m, ptr + 5) > 0 ? 0x20 : 0) | (s0(m, ptr + 8) > 0 ? 0x10 : 0) |
              (s2(m, ptr + 10) > 0 ? 0x08 : 0) | (s4(m, ptr + 12) > 0 ? 0x04 : 0) |
              (s1(m, ptr + 15) > 0 ? 0x02 : 0) | (s3(m, ptr + 17) > 0 ? 0x01 : 0)
            phase = 0
            ptr += 20
            break
        }
        msg[i] = b
        if (i === 0) {
          const df = b >> 3
          if (VALID_LONG & (1 << df)) len = 14
          else if (VALID_SHORT & (1 << df)) len = 7
        }
      }
      if (len === 1) continue
      if (len === 7) msg.fill(0, 7)
      const sc = this.score(msg)
      if (sc > bestScore) {
        best = msg
        bestLen = len
        bestScore = sc
        msg = msg === this.bufA ? this.bufB : this.bufA
      }
    }
    if (!best || bestScore < Score.Accept) return 0
    this.best = best
    this.bestScore = bestScore
    return bestLen
  }

  private slice2000(m: Float32Array, at: number, out: Uint8Array): number {
    out.fill(0)
    for (let i = 0; i < 112; i++) {
      if (m[at + 2 * i] > m[at + 2 * i + 1]) out[i >> 3] |= 0x80 >> (i & 7)
    }
    const df = out[0] >> 3
    if (VALID_LONG & (1 << df)) return 14
    if (VALID_SHORT & (1 << df)) {
      out.fill(0, 7)
      return 7
    }
    return 0
  }

  /**
   * Rescales each data sample by the energy its neighbour leaked into it,
   * judged from the preamble. Works on a copy holding m[j - 1] at index 0.
   */
  private phaseCorrect(m: Float32Array, j: number): Float32Array {
    const s = this.scratch
    const n = 1 + 16 + 224
    for (let k = 0; k < n; k++) s[k] = m[j - 1 + k]
    const p = 1
    const on = s[p] + s[p + 2] + s[p + 7] + s[p + 9]
    const early = (s[p - 1] + s[p + 6]) * 2
    const late = (s[p + 3] + s[p + 10]) * 2
    const first = p + 16
    const last = p + 16 + 224 - 1
    if (early > late) {
      const up = 1 + early / (early + on)
      const down = 1 - early / (early + on)
      s[last] *= up
      for (let k = last - 1; k > first; k -= 2) {
        s[k - 1] *= s[k] > s[k + 1] ? down : up
      }
    } else {
      const up = 1 + late / (late + on)
      const down = 1 - late / (late + on)
      s[first] *= up
      for (let k = first; k < last - 1; k += 2) {
        s[k + 2] *= s[k] > s[k + 1] ? up : down
      }
    }
    return s
  }

  private scan2000(end: number): void {
    const m = this.mag
    for (let j = Math.max(1, this.resume); j < end; j++) {
      if (
        !(
          m[j] > m[j + 1] && m[j + 1] < m[j + 2] && m[j + 2] > m[j + 3] &&
          m[j + 3] < m[j] && m[j + 4] < m[j] && m[j + 5] < m[j] && m[j + 6] < m[j] &&
          m[j + 7] > m[j + 8] && m[j + 8] < m[j + 9] && m[j + 9] > m[j + 6]
        )
      ) {
        continue
      }
      const high = (m[j] + m[j + 2] + m[j + 7] + m[j + 9]) / 6
      if (m[j + 4] >= high || m[j + 5] >= high) continue
      if (m[j + 11] >= high || m[j + 12] >= high || m[j + 13] >= high || m[j + 14] >= high) continue
      this.preambles++

      let msg = this.bufA
      let len = this.slice2000(m, j + 16, msg)
      let sc: Score = len ? this.score(msg) : Score.NotSet
      if (sc < Score.Accept) {
        const fixed = this.phaseCorrect(m, j)
        const alt = this.bufB
        const len2 = this.slice2000(fixed, 1 + 16, alt)
        const sc2 = len2 ? this.score(alt) : Score.NotSet
        if (sc2 > sc) {
          msg = alt
          len = len2
          sc = sc2
        }
      }
      if (sc < Score.Accept) continue

      const bits = len * 8
      this.emit(msg, sc, j, j + 16, bits * 2)
      j += 16 + bits * 2 - 1
      this.resume = j + 1
    }
  }
}

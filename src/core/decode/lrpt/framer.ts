/**
 * Soft symbols to corrected CADUs.
 *
 * The attached sync marker is found before Viterbi decoding, by correlating
 * the soft stream against the marker as the convolutional encoder sends it.
 * Only the last 26 of its 32 coded pairs are used, since the first six depend
 * on the end of the frame before. The carrier loop can settle on any of four
 * phases and the spectrum may arrive inverted, so the search runs over each
 * way the rails could be swapped or negated, and the sign of the peak gives
 * the polarity. OQPSK keeps its rails apart in time, so only the Q sign is in
 * question there.
 *
 * Meteor M2-3 and M2-4 differentially encode (NRZ-M) the bits before the
 * convolutional encoder, which removes the polarity question but changes the
 * coded marker. The original M2 did not.
 *
 * A hit has to repeat one frame later before the framer locks. Once locked it
 * checks a few symbols either side of where the next marker should be, and
 * keeps going on the predicted spot through a run of misses so a short fade
 * costs only the frames inside it.
 */

import { ASM, CADU_BITS, CADU_BYTES, derandomize, rsDecodeCadu } from './ccsds'
import { Viterbi, convEncode } from './viterbi'

const FRAME_SOFT = CADU_BITS * 2
/** Extra coded pairs decoded either side of a frame so its ends are settled. */
const MARGIN_PAIRS = 48
const MARGIN = MARGIN_PAIRS * 2
const PATTERN_FROM = 12
const PATTERN_LEN = 64 - PATTERN_FROM
const HUNT_THRESHOLD = 0.6
const TRACK_THRESHOLD = 0.45
const MAX_MISSES = 8
const SLIP = 2

export interface FramerOptions {
  oqpsk: boolean
  nrzm: boolean
}

export interface Frame {
  /** Derandomized and, where it could be, corrected. */
  cadu: Uint8Array
  /** Symbols fixed per interleaved codeword, -1 for a failure. */
  rs: Int16Array
  ok: boolean
  /** Channel bit error rate the Viterbi decoder saw on this frame, 0 to 1. */
  ber: number
}

export interface FramerStats {
  locked: boolean
  frames: number
  rsOk: number
  rsFail: number
  /** Symbols corrected across every good frame. */
  rsFixed: number
  ber: number
}

/** Rail transforms on a pair (a, b), indexed as below. */
type Transform = 0 | 1 | 2 | 3
const QPSK_TRANSFORMS: Transform[] = [0, 1, 2, 3]
const OQPSK_TRANSFORMS: Transform[] = [0, 2]

function codedMarker(nrzm: boolean): Int8Array {
  const bits = new Uint8Array(32)
  let prev = 0
  for (let i = 0; i < 32; i++) {
    const b = (ASM >>> (31 - i)) & 1
    if (nrzm) {
      prev ^= b
      bits[i] = prev
    } else {
      bits[i] = b
    }
  }
  const { out } = convEncode(bits, 0)
  const p = new Int8Array(PATTERN_LEN)
  for (let i = 0; i < PATTERN_LEN; i++) p[i] = out[PATTERN_FROM + i] ? 1 : -1
  return p
}

export class LrptFramer {
  private readonly opts: FramerOptions
  private readonly pattern: Int8Array
  private readonly transforms: Transform[]
  private readonly viterbi = new Viterbi()

  /** Raw soft stream. buf[0] is absolute index `base`, always even. */
  private buf = new Int8Array(1 << 17)
  private len = 0
  private base = 0

  private locked = false
  private next = 0
  private transform: Transform = 0
  private sign = 1
  private misses = 0
  private failRun = 0

  private window = new Int8Array(FRAME_SOFT + 2 * MARGIN)
  private bits = new Uint8Array(CADU_BITS + 2 * MARGIN_PAIRS)
  private hunt: Int8Array[] = []
  private readonly s: FramerStats = { locked: false, frames: 0, rsOk: 0, rsFail: 0, rsFixed: 0, ber: 0 }

  constructor(opts: FramerOptions) {
    this.opts = opts
    this.pattern = codedMarker(opts.nrzm)
    this.transforms = opts.oqpsk ? OQPSK_TRANSFORMS : QPSK_TRANSFORMS
  }

  get stats(): FramerStats {
    return { ...this.s, locked: this.locked }
  }

  reset(): void {
    this.len = 0
    this.base = 0
    this.locked = false
    this.misses = 0
    Object.assign(this.s, { locked: false, frames: 0, rsOk: 0, rsFail: 0, rsFixed: 0, ber: 0 })
  }

  push(soft: Int8Array): Frame[] {
    this.append(soft)
    const out: Frame[] = []
    for (;;) {
      if (!this.locked) {
        if (!this.search()) break
        continue
      }
      if (this.base + this.len < this.next + FRAME_SOFT + MARGIN + SLIP) break
      out.push(this.decodeFrame())
    }
    return out
  }

  private append(soft: Int8Array): void {
    if (this.len + soft.length > this.buf.length) {
      const grown = new Int8Array(Math.max(this.buf.length * 2, this.len + soft.length))
      grown.set(this.buf.subarray(0, this.len))
      this.buf = grown
    }
    this.buf.set(soft, this.len)
    this.len += soft.length
  }

  /** Drops everything before absolute index `abs`, keeping the base even. */
  private drop(abs: number): void {
    const n = Math.min(this.len, (abs - this.base) & ~1)
    if (n <= 0) return
    this.buf.copyWithin(0, n, this.len)
    this.len -= n
    this.base += n
  }

  /** Transformed soft value at absolute index r. */
  private at(t: Transform, r: number): number {
    const i = r - this.base
    const p = i & ~1
    const a = this.buf[p]
    const b = this.buf[p + 1]
    if ((i & 1) === 0) return t === 0 || t === 2 ? a : b
    if (t === 0) return b
    if (t === 1) return -a
    if (t === 2) return -b
    return a
  }

  /** Normalized marker correlation at absolute index r, signed. */
  private correlate(t: Transform, r: number): number {
    let sum = 0
    let mag = 0
    for (let j = 0; j < PATTERN_LEN; j++) {
      const v = this.at(t, r + PATTERN_FROM + j)
      sum += v * this.pattern[j]
      mag += v < 0 ? -v : v
    }
    return mag > 0 ? sum / mag : 0
  }

  /** Looks for a marker that repeats one frame later. True when it changed state. */
  private search(): boolean {
    const span = FRAME_SOFT
    const need = 2 * FRAME_SOFT + 64 + 2
    if (this.len < need) return false

    if (this.hunt.length !== 4 || this.hunt[0].length < need) {
      this.hunt = [0, 1, 2, 3].map(() => new Int8Array(need))
    }
    for (const t of this.transforms) {
      const h = this.hunt[t]
      for (let k = 0; k < need; k++) h[k] = this.at(t, this.base + k)
    }

    const pat = this.pattern
    let best = 0
    let bestAt = -1
    let bestT: Transform = 0
    for (const t of this.transforms) {
      const h = this.hunt[t]
      for (let o = 0; o < span; o++) {
        let s1 = 0
        let m1 = 0
        let s2 = 0
        let m2 = 0
        const a = o + PATTERN_FROM
        const b = a + FRAME_SOFT
        for (let j = 0; j < PATTERN_LEN; j++) {
          const v = h[a + j]
          const w = h[b + j]
          s1 += v * pat[j]
          m1 += v < 0 ? -v : v
          s2 += w * pat[j]
          m2 += w < 0 ? -w : w
        }
        if (m1 === 0 || m2 === 0) continue
        const c1 = s1 / m1
        const c2 = s2 / m2
        // both hits must agree on polarity.
        if (c1 * c2 <= 0) continue
        const c = (c1 + c2) / 2
        if (Math.abs(c) > Math.abs(best)) {
          best = c
          bestAt = o
          bestT = t
        }
      }
    }

    if (bestAt < 0 || Math.abs(best) < HUNT_THRESHOLD) {
      this.drop(this.base + span)
      return true
    }
    this.locked = true
    this.next = this.base + bestAt
    this.transform = bestT
    this.sign = best < 0 ? -1 : 1
    this.misses = 0
    return true
  }

  private best(transforms: Transform[]): { c: number; at: number; t: Transform } {
    let c = 0
    let at = this.next
    let tb = this.transform
    for (const t of transforms) {
      for (let d = -SLIP; d <= SLIP; d++) {
        const r = this.next + d
        if (r + PATTERN_FROM < this.base) continue
        const v = this.correlate(t, r)
        if (Math.abs(v) > Math.abs(c)) {
          c = v
          at = r
          tb = t
        }
      }
    }
    return { c, at, t: tb }
  }

  /** Refines the frame start, then decodes the frame at it. */
  private decodeFrame(): Frame {
    // the phase the loop already holds needs less evidence than a slip to
    // another one, or noise would keep resetting the miss count.
    let hit = this.best([this.transform])
    if (Math.abs(hit.c) < TRACK_THRESHOLD) {
      const other = this.best(this.transforms.filter((t) => t !== this.transform))
      if (Math.abs(other.c) >= HUNT_THRESHOLD) hit = other
    }
    if (Math.abs(hit.c) >= TRACK_THRESHOLD) {
      this.next = hit.at
      this.transform = hit.t
      this.sign = hit.c < 0 ? -1 : 1
      this.misses = 0
    } else {
      this.misses++
    }

    const start = this.next
    const frame = this.decodeAt(start)
    this.next = start + FRAME_SOFT
    this.failRun = frame.ok ? 0 : this.failRun + 1
    if (this.misses > MAX_MISSES || (this.misses > 1 && this.failRun > 2)) {
      this.locked = false
      this.drop(this.next - MARGIN)
    } else {
      this.drop(start + FRAME_SOFT - 2 * MARGIN)
    }
    return frame
  }

  private decodeAt(start: number): Frame {
    const w = this.window
    const from = start - MARGIN
    const t = this.transform
    const sign = this.sign
    for (let k = 0; k < w.length; k++) {
      const r = from + k
      w[k] = r < this.base ? 0 : sign * this.at(t, r)
    }
    const pairs = w.length / 2
    const bits = this.bits
    this.viterbi.decode(w, 0, pairs, bits)

    // channel errors, by coding the decision back up and comparing it with
    // the hard symbols. the first six pairs have an unknown encoder state.
    let state = 0
    for (let k = 0; k < 6; k++) state = (state >> 1) | (bits[k] << 5)
    const { out } = convEncode(bits.subarray(6), state)
    let errors = 0
    let counted = 0
    for (let k = 0; k < out.length; k++) {
      const v = w[12 + k]
      if (v === 0) continue
      counted++
      if ((v > 0 ? 1 : 0) !== out[k]) errors++
    }
    const ber = counted ? errors / counted : 0.5

    const cadu = new Uint8Array(CADU_BYTES)
    const nrzm = this.opts.nrzm
    for (let i = 0; i < CADU_BITS; i++) {
      const k = MARGIN_PAIRS + i
      const b = nrzm ? bits[k] ^ bits[k - 1] : bits[k]
      cadu[i >> 3] |= b << (7 - (i & 7))
    }
    derandomize(cadu)
    const rs = new Int16Array(4)
    const ok = rsDecodeCadu(cadu, rs)

    this.s.frames++
    if (ok) {
      this.s.rsOk++
      for (let c = 0; c < 4; c++) this.s.rsFixed += rs[c]
    } else {
      this.s.rsFail++
    }
    this.s.ber = ber
    return { cadu, rs, ok, ber }
  }
}

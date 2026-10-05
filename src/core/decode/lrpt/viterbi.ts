/**
 * Rate 1/2, constraint length 7 convolutional code, the CCSDS pair
 * G1 = 0171 and G2 = 0133. Meteor sends G2 uninverted.
 *
 * Soft symbols are signed bytes, positive meaning a one. The decoder works on
 * whole windows: it starts with every state equally likely and traces back
 * from the best end state, so a caller decodes a frame plus a little either
 * side and keeps the middle.
 */

export const G1 = 0x79
export const G2 = 0x5b

function parity(x: number): number {
  x ^= x >> 4
  x ^= x >> 2
  x ^= x >> 1
  return x & 1
}

/** Output pair for (input bit << 6 | six bit history), G1 in bit 1. */
const OUTPUT = (() => {
  const t = new Uint8Array(128)
  for (let i = 0; i < 128; i++) t[i] = (parity(i & G1) << 1) | parity(i & G2)
  return t
})()

/**
 * For next state n and the oldest bit b of its predecessor, the pair the
 * transition sends. The state holds the last six inputs, newest at bit 5.
 */
const BRANCH = (() => {
  const t = new Uint8Array(128)
  for (let n = 0; n < 64; n++) {
    const u = n >> 5
    for (let b = 0; b < 2; b++) {
      const prev = ((n << 1) & 63) | b
      t[n * 2 + b] = OUTPUT[(u << 6) | prev]
    }
  }
  return t
})()

/** Encodes bits (one per byte), continuing from and updating `state`. */
export function convEncode(bits: Uint8Array, state = 0): { out: Uint8Array; state: number } {
  const out = new Uint8Array(bits.length * 2)
  let s = state & 63
  for (let i = 0; i < bits.length; i++) {
    const u = bits[i] & 1
    const o = OUTPUT[(u << 6) | s]
    out[2 * i] = o >> 1
    out[2 * i + 1] = o & 1
    s = (s >> 1) | (u << 5)
  }
  return { out, state: s }
}

export class Viterbi {
  private metric = new Int32Array(64)
  private next = new Int32Array(64)
  private decisions = new Uint8Array(0)
  private bm = new Int32Array(4)

  /**
   * Decodes `pairs` symbol pairs starting at `soft[start]`, writing one bit
   * per byte into `out`.
   */
  decode(soft: Int8Array, start: number, pairs: number, out: Uint8Array): void {
    if (this.decisions.length < pairs * 64) this.decisions = new Uint8Array(pairs * 64)
    const dec = this.decisions
    let m = this.metric
    let nx = this.next
    m.fill(0)
    const bm = this.bm

    for (let t = 0; t < pairs; t++) {
      const s0 = soft[start + 2 * t]
      const s1 = soft[start + 2 * t + 1]
      bm[0] = -s0 - s1
      bm[1] = -s0 + s1
      bm[2] = s0 - s1
      bm[3] = s0 + s1
      const base = t * 64
      for (let n = 0; n < 64; n++) {
        const p0 = (n << 1) & 63
        const a = m[p0] + bm[BRANCH[2 * n]]
        const b = m[p0 | 1] + bm[BRANCH[2 * n + 1]]
        if (b > a) {
          nx[n] = b
          dec[base + n] = 1
        } else {
          nx[n] = a
          dec[base + n] = 0
        }
      }
      const tmp = m
      m = nx
      nx = tmp
    }
    this.metric = m
    this.next = nx

    let best = 0
    for (let n = 1; n < 64; n++) if (m[n] > m[best]) best = n
    let n = best
    for (let t = pairs - 1; t >= 0; t--) {
      out[t] = n >> 5
      n = ((n << 1) & 63) | dec[t * 64 + n]
    }
  }
}

/**
 * The CCSDS link layer pieces Meteor LRPT uses: the attached sync marker, the
 * pseudo-random derandomizer, and Reed-Solomon (255,223) interleaved four
 * deep in the conventional basis, with no dual basis conversion.
 *
 * Written from CCSDS 131.0-B and the Meteor-M LRPT format notes.
 */

export const ASM = 0x1acffc1d
export const CADU_BYTES = 1024
export const CADU_BITS = CADU_BYTES * 8
export const RS_DEPTH = 4
export const RS_N = 255
export const RS_K = 223
export const RS_PARITY = RS_N - RS_K

const GF_POLY = 0x187
const FCR = 112
const PRIM = 11
const IPRIM = 116
const NN = 255
const A0 = NN

const ALPHA = new Uint8Array(256)
const INDEX = new Uint8Array(256)
{
  let sr = 1
  for (let i = 0; i < NN; i++) {
    INDEX[sr] = i
    ALPHA[i] = sr
    sr <<= 1
    if (sr & 0x100) sr ^= GF_POLY
  }
  ALPHA[A0] = 0
  INDEX[0] = A0
}

function modnn(x: number): number {
  while (x >= NN) {
    x -= NN
    x = (x >> 8) + (x & NN)
  }
  return x
}

/** Generator polynomial in index form, lowest degree first. */
const GENPOLY = (() => {
  const g = new Uint8Array(RS_PARITY + 1)
  g[0] = 1
  for (let i = 0, root = FCR * PRIM; i < RS_PARITY; i++, root += PRIM) {
    g[i + 1] = 1
    for (let j = i; j > 0; j--) {
      g[j] = g[j] !== 0 ? g[j - 1] ^ ALPHA[modnn(INDEX[g[j]] + root)] : g[j - 1]
    }
    g[0] = ALPHA[modnn(INDEX[g[0]] + root)]
  }
  for (let i = 0; i <= RS_PARITY; i++) g[i] = INDEX[g[i]]
  return g
})()

/** The CCSDS pseudo-random sequence, x^8 + x^7 + x^5 + x^3 + 1 seeded with ones. */
export const PN = (() => {
  const out = new Uint8Array(RS_N)
  let sr = 0xff
  for (let i = 0; i < RS_N; i++) {
    out[i] = sr
    for (let b = 0; b < 8; b++) {
      const fb = (sr ^ (sr >> 2) ^ (sr >> 4) ^ (sr >> 7)) & 1
      sr = ((sr << 1) | fb) & 0xff
    }
  }
  return out
})()

/** XORs the sequence over everything after the marker. Its own inverse. */
export function derandomize(cadu: Uint8Array): void {
  for (let i = 4; i < CADU_BYTES; i++) cadu[i] ^= PN[(i - 4) % RS_N]
}

const syn = new Uint8Array(RS_PARITY)
const lambda = new Uint8Array(RS_PARITY + 1)
const bpoly = new Uint8Array(RS_PARITY + 1)
const tpoly = new Uint8Array(RS_PARITY + 1)
const omega = new Uint8Array(RS_PARITY + 1)
const reg = new Uint8Array(RS_PARITY + 1)
const root = new Uint8Array(RS_PARITY)
const loc = new Uint8Array(RS_PARITY)

/**
 * Corrects one 255 byte codeword in place. Returns the number of symbols
 * fixed, or -1 when the errors are beyond the code's reach of 16.
 */
export function rsDecode(data: Uint8Array): number {
  for (let i = 0; i < RS_PARITY; i++) syn[i] = data[0]
  for (let j = 1; j < NN; j++) {
    const d = data[j]
    for (let i = 0; i < RS_PARITY; i++) {
      const s = syn[i]
      syn[i] = s === 0 ? d : d ^ ALPHA[modnn(INDEX[s] + (FCR + i) * PRIM)]
    }
  }
  let any = 0
  for (let i = 0; i < RS_PARITY; i++) {
    any |= syn[i]
    syn[i] = INDEX[syn[i]]
  }
  if (!any) return 0

  lambda.fill(0)
  lambda[0] = 1
  for (let i = 0; i <= RS_PARITY; i++) bpoly[i] = INDEX[lambda[i]]
  let r = 0
  let el = 0
  while (++r <= RS_PARITY) {
    let discr = 0
    for (let i = 0; i < r; i++) {
      if (lambda[i] !== 0 && syn[r - i - 1] !== A0) {
        discr ^= ALPHA[modnn(INDEX[lambda[i]] + syn[r - i - 1])]
      }
    }
    const dIdx = INDEX[discr]
    if (dIdx === A0) {
      bpoly.copyWithin(1, 0, RS_PARITY)
      bpoly[0] = A0
    } else {
      tpoly[0] = lambda[0]
      for (let i = 0; i < RS_PARITY; i++) {
        tpoly[i + 1] = bpoly[i] !== A0 ? lambda[i + 1] ^ ALPHA[modnn(dIdx + bpoly[i])] : lambda[i + 1]
      }
      if (2 * el <= r - 1) {
        el = r - el
        for (let i = 0; i <= RS_PARITY; i++) {
          bpoly[i] = lambda[i] === 0 ? A0 : modnn(INDEX[lambda[i]] - dIdx + NN)
        }
      } else {
        bpoly.copyWithin(1, 0, RS_PARITY)
        bpoly[0] = A0
      }
      lambda.set(tpoly)
    }
  }

  let degLambda = 0
  for (let i = 0; i <= RS_PARITY; i++) {
    lambda[i] = INDEX[lambda[i]]
    if (lambda[i] !== A0) degLambda = i
  }
  if (degLambda === 0) return -1

  reg.set(lambda)
  let count = 0
  for (let i = 1, k = IPRIM - 1; i <= NN; i++, k = modnn(k + IPRIM)) {
    let q = 1
    for (let j = degLambda; j > 0; j--) {
      if (reg[j] !== A0) {
        reg[j] = modnn(reg[j] + j)
        q ^= ALPHA[reg[j]]
      }
    }
    if (q !== 0) continue
    root[count] = i
    loc[count] = k
    if (++count === degLambda) break
  }
  if (count !== degLambda) return -1

  const degOmega = degLambda - 1
  for (let i = 0; i <= degOmega; i++) {
    let tmp = 0
    for (let j = i; j >= 0; j--) {
      if (syn[i - j] !== A0 && lambda[j] !== A0) tmp ^= ALPHA[modnn(syn[i - j] + lambda[j])]
    }
    omega[i] = INDEX[tmp]
  }

  for (let j = count - 1; j >= 0; j--) {
    let num1 = 0
    for (let i = degOmega; i >= 0; i--) {
      if (omega[i] !== A0) num1 ^= ALPHA[modnn(omega[i] + i * root[j])]
    }
    const num2 = ALPHA[modnn(root[j] * (FCR - 1) + NN)]
    let den = 0
    for (let i = Math.min(degLambda, RS_PARITY - 1) & ~1; i >= 0; i -= 2) {
      if (lambda[i + 1] !== A0) den ^= ALPHA[modnn(lambda[i + 1] + i * root[j])]
    }
    if (den === 0) return -1
    if (num1 !== 0) {
      data[loc[j]] ^= ALPHA[modnn(INDEX[num1] + INDEX[num2] + NN - INDEX[den])]
    }
  }
  return count
}

/** Appends 32 parity bytes to 223 data bytes. Used by the demo transmitter. */
export function rsEncode(data: Uint8Array): Uint8Array {
  const bb = new Uint8Array(RS_PARITY)
  for (let i = 0; i < RS_K; i++) {
    const fb = INDEX[data[i] ^ bb[0]]
    if (fb !== A0) {
      for (let j = 1; j < RS_PARITY; j++) bb[j] ^= ALPHA[modnn(fb + GENPOLY[RS_PARITY - j])]
    }
    bb.copyWithin(0, 1)
    bb[RS_PARITY - 1] = fb !== A0 ? ALPHA[modnn(fb + GENPOLY[0])] : 0
  }
  return bb
}

const word = new Uint8Array(RS_N)

/**
 * Corrects the four interleaved codewords of a derandomized CADU in place.
 * Returns the symbols fixed in each, -1 for a codeword that failed.
 */
export function rsDecodeCadu(cadu: Uint8Array, out: Int16Array): boolean {
  let ok = true
  for (let c = 0; c < RS_DEPTH; c++) {
    for (let k = 0; k < RS_N; k++) word[k] = cadu[4 + c + k * RS_DEPTH]
    const n = rsDecode(word)
    out[c] = n
    if (n < 0) {
      ok = false
      continue
    }
    if (n > 0) for (let k = 0; k < RS_N; k++) cadu[4 + c + k * RS_DEPTH] = word[k]
  }
  return ok
}

/** Fills the parity of a CADU whose first 896 bytes are set. */
export function rsEncodeCadu(cadu: Uint8Array): void {
  const block = new Uint8Array(RS_K)
  for (let c = 0; c < RS_DEPTH; c++) {
    for (let k = 0; k < RS_K; k++) block[k] = cadu[4 + c + k * RS_DEPTH]
    const parity = rsEncode(block)
    for (let k = 0; k < RS_PARITY; k++) cadu[4 + c + (RS_K + k) * RS_DEPTH] = parity[k]
  }
}

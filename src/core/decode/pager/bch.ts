/**
 * The BCH(31,21) code POCSAG and FLEX share, generator x^10 + x^9 + x^8 +
 * x^6 + x^5 + x^3 + 1, with an even parity bit on top. It corrects any two
 * bit errors in a word.
 *
 * POCSAG sends a codeword most significant bit first: 21 data bits, 10 check
 * bits, then the parity bit. FLEX sends the same code least significant bit
 * first, so its words are bit reversed against POCSAG's and run through the
 * same table after reversing.
 */

const GENERATOR = 0x769

/** Remainder of a 31 bit word, most significant bit first, over the generator. */
export function bchRemainder(word31: number): number {
  let v = word31 >>> 0
  for (let i = 30; i >= 10; i--) {
    if (v & (1 << i)) v ^= GENERATOR << (i - 10)
  }
  return v & 0x3ff
}

function parity32(v: number): number {
  v ^= v >>> 16
  v ^= v >>> 8
  v ^= v >>> 4
  v ^= v >>> 2
  v ^= v >>> 1
  return v & 1
}

/** Syndrome to error pattern, for every one and two bit error. -1 is uncorrectable. */
const ERRORS = (() => {
  const table = new Int32Array(1024).fill(-1)
  table[0] = 0
  for (let a = 0; a < 31; a++) {
    table[bchRemainder(1 << a)] = 1 << a
    for (let b = a + 1; b < 31; b++) {
      const e = ((1 << a) | (1 << b)) >>> 0
      table[bchRemainder(e)] = e
    }
  }
  return table
})()

function popcount(v: number): number {
  let n = 0
  for (let x = v >>> 0; x; x &= x - 1) n++
  return n
}

export interface Corrected {
  word: number
  /** Bits flipped to make the word valid, or -1 when it could not be. */
  errors: number
}

/** Corrects a 31 bit word laid out most significant bit first. */
export function bchCorrect31(word31: number): Corrected {
  const syn = bchRemainder(word31)
  const e = ERRORS[syn]
  if (e < 0) return { word: word31 >>> 0, errors: -1 }
  return { word: (word31 ^ e) >>> 0, errors: popcount(e) }
}

/**
 * Corrects a POCSAG codeword. Up to two flipped bits anywhere in the 32,
 * parity bit included, come back fixed.
 */
export function pocsagCorrect(cw: number): Corrected {
  const head = bchCorrect31(cw >>> 1)
  if (head.errors < 0) return { word: cw >>> 0, errors: -1 }
  let word = ((head.word << 1) | (cw & 1)) >>> 0
  let errors = head.errors
  if (parity32(word)) {
    if (errors >= 2) return { word: cw >>> 0, errors: -1 }
    word = (word ^ 1) >>> 0
    errors++
  }
  return { word, errors }
}

/** A POCSAG codeword for 21 data bits: check bits and parity appended. */
export function pocsagEncode(data21: number): number {
  const head = ((data21 & 0x1fffff) << 10) >>> 0
  const word31 = (head | bchRemainder(head)) >>> 0
  const cw = (word31 << 1) >>> 0
  return (cw | parity32(cw)) >>> 0
}

export function reverse31(v: number): number {
  let r = 0
  for (let i = 0; i < 31; i++) if (v & (1 << i)) r |= 1 << (30 - i)
  return r >>> 0
}

/**
 * Corrects a FLEX word as received, first bit in bit 0. The data comes back
 * in the low 21 bits. The top bit is FLEX's even parity, which only counts
 * against the word when the code already used both its corrections.
 */
export function flexCorrect(word32: number): Corrected {
  const fixed = bchCorrect31(reverse31(word32 & 0x7fffffff))
  if (fixed.errors < 0) return { word: word32 >>> 0, errors: -1 }
  const word31 = reverse31(fixed.word)
  const top = word32 & 0x80000000 ? 1 : 0
  if (fixed.errors === 2 && (parity32(word31) ^ top) !== 0) {
    return { word: word32 >>> 0, errors: -1 }
  }
  return { word: word31, errors: fixed.errors }
}

/** A FLEX word for 21 data bits, first bit to send in bit 0. */
export function flexEncode(data21: number): number {
  const head = ((reverse31(data21 & 0x1fffff) >>> 10) << 10) >>> 0
  const word31 = reverse31((head | bchRemainder(head)) >>> 0)
  return (word31 | (parity32(word31) << 31)) >>> 0
}

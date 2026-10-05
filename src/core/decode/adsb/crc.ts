/**
 * The Mode S parity check: a 24 bit CRC over the whole message, generator
 * 0x1FFF409, carried in the last 24 bits.
 *
 * DF11, DF17 and DF18 put the plain parity there, so a good message leaves a
 * zero remainder (DF11 may leave an interrogator id in the low 7 bits). DF0,
 * 4, 5, 16, 20 and 21 overlay the aircraft address on the parity, so their
 * remainder is the address, and it can only be trusted when that address has
 * already been heard on a checked message.
 */

const POLY = 0xfff409

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i << 16
    for (let b = 0; b < 8; b++) c = c & 0x800000 ? ((c << 1) ^ POLY) & 0xffffff : (c << 1) & 0xffffff
    t[i] = c
  }
  return t
})()

/** The CRC remainder of the first `bits` bits, xored with the parity field. */
export function modesChecksum(msg: Uint8Array, bits: number): number {
  const n = bits >> 3
  let rem = 0
  for (let i = 0; i < n - 3; i++) {
    rem = ((rem << 8) ^ TABLE[msg[i] ^ (rem >>> 16)]) & 0xffffff
  }
  return (rem ^ (msg[n - 3] << 16) ^ (msg[n - 2] << 8) ^ msg[n - 1]) >>> 0
}

/**
 * Syndrome to bit index for every single bit error, one table per length.
 * With one bit corrected the code still detects every pattern of up to four
 * errors, so no syndrome in these tables is ambiguous.
 */
function singleBitTable(bits: number): Map<number, number> {
  const map = new Map<number, number>()
  const msg = new Uint8Array(bits >> 3)
  for (let i = 0; i < bits; i++) {
    msg[i >> 3] ^= 0x80 >> (i & 7)
    map.set(modesChecksum(msg, bits), i)
    msg[i >> 3] ^= 0x80 >> (i & 7)
  }
  return map
}

const SHORT_FIX = singleBitTable(56)
const LONG_FIX = singleBitTable(112)

/** The bit a syndrome points at, or -1 when one flipped bit cannot explain it. */
export function singleBitError(syndrome: number, bits: 56 | 112): number {
  return (bits === 56 ? SHORT_FIX : LONG_FIX).get(syndrome) ?? -1
}

export function flipBit(msg: Uint8Array, bit: number): void {
  msg[bit >> 3] ^= 0x80 >> (bit & 7)
}

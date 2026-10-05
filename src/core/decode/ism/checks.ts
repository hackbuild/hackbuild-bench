/**
 * Integrity checks the ism protocols use, ported from rtl_433's bit_util.c
 * (GPL-2.0-or-later).
 */

export function crc8(msg: ArrayLike<number>, bytes: number, poly: number, init: number): number {
  let rem = init & 0xff
  for (let i = 0; i < bytes; i++) {
    rem ^= msg[i]
    for (let b = 0; b < 8; b++) rem = rem & 0x80 ? ((rem << 1) ^ poly) & 0xff : (rem << 1) & 0xff
  }
  return rem
}

/** Galois LFSR digest, message bits msb first, key rolled right. */
export function lfsrDigest8(msg: ArrayLike<number>, bytes: number, gen: number, key: number): number {
  let sum = 0
  for (let k = 0; k < bytes; k++) {
    const data = msg[k]
    for (let i = 7; i >= 0; i--) {
      if ((data >> i) & 1) sum ^= key
      key = key & 1 ? (key >> 1) ^ gen : key >> 1
    }
  }
  return sum & 0xff
}

/** The same digest run backwards over the message, each byte lsb first, key rolled left. */
export function lfsrDigest8Reflect(msg: ArrayLike<number>, bytes: number, gen: number, key: number): number {
  let sum = 0
  for (let k = bytes - 1; k >= 0; k--) {
    const data = msg[k]
    for (let i = 0; i < 8; i++) {
      if ((data >> i) & 1) sum ^= key
      key = key & 0x80 ? ((key << 1) ^ gen) & 0xff : (key << 1) & 0xff
    }
  }
  return sum & 0xff
}

export function parity8(byte: number): number {
  let b = byte ^ (byte >> 4)
  b &= 0xf
  return (0x6996 >> b) & 1
}

export function parityBytes(msg: ArrayLike<number>, bytes: number, from = 0): number {
  let r = 0
  for (let i = 0; i < bytes; i++) r ^= parity8(msg[from + i])
  return r
}

export function addBytes(msg: ArrayLike<number>, bytes: number): number {
  let r = 0
  for (let i = 0; i < bytes; i++) r += msg[i]
  return r
}

export function xorBytes(msg: ArrayLike<number>, bytes: number): number {
  let r = 0
  for (let i = 0; i < bytes; i++) r ^= msg[i]
  return r
}

export function reflect4(x: number): number {
  x = ((x & 0xcc) >> 2) | ((x & 0x33) << 2)
  x = ((x & 0xaa) >> 1) | ((x & 0x55) << 1)
  return x & 0xff
}

export function reflectNibbles(msg: Uint8Array, bytes: number): void {
  for (let i = 0; i < bytes; i++) msg[i] = reflect4(msg[i])
}

/** C float arithmetic, so a reading lands on the same value rtl_433 prints. */
export function f32(x: number): number {
  return Math.fround(x)
}

export function f32mul(a: number, b: number): number {
  return Math.fround(Math.fround(a) * Math.fround(b))
}

/** rtl_433's json prints doubles to three places. */
export function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}

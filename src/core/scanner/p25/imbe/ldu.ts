/**
 * Where the voice sits in a P25 phase 1 logical link data unit.
 *
 * An LDU carries nine IMBE frames of 72 dibits each, with link control or
 * encryption sync words and low speed data between them. Counted in
 * information dibits after the NID, status dibits already removed, the
 * frames start at these offsets.
 *
 * The interleave tables come from DSD's p25p1_const.h. DSD: Copyright (C)
 * 2010 DSD Author. Permission to use, copy, modify, and/or distribute this
 * software for any purpose with or without fee is hereby granted, provided
 * that the above copyright notice and this permission notice appear in all
 * copies. THE SOFTWARE IS PROVIDED "AS IS" AND ISC DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE.
 */

import { newFrame } from './vocoder'
import type { ImbeFrame } from './vocoder'

/** Information dibits in an LDU after the NID. */
export const LDU_DIBITS = 784

const FRAME_STARTS = [0, 72, 164, 256, 348, 440, 532, 624, 712]

// prettier-ignore
const iW = [0,2,4,1,3,5,0,2,4,1,3,6,0,2,4,1,3,6,0,2,4,1,3,6,0,2,4,1,3,6,0,2,4,1,3,6,0,2,5,1,3,6,0,2,5,1,3,6,0,2,5,1,3,7,0,2,5,1,3,7,0,2,5,1,4,7,0,3,5,2,4,7]
// prettier-ignore
const iX = [22,20,10,20,18,0,20,18,8,18,16,13,18,16,6,16,14,11,16,14,4,14,12,9,14,12,2,12,10,7,12,10,0,10,8,5,10,8,13,8,6,3,8,6,11,6,4,1,6,4,9,4,2,6,4,2,7,2,0,4,2,0,5,0,13,2,0,21,3,21,11,0]
// prettier-ignore
const iY = [1,3,5,0,2,4,1,3,6,0,2,4,1,3,6,0,2,4,1,3,6,0,2,4,1,3,6,0,2,4,1,3,6,0,2,5,1,3,6,0,2,5,1,3,6,0,2,5,1,3,6,0,2,5,1,3,7,0,2,5,1,4,7,0,3,5,2,4,7,1,3,5]
// prettier-ignore
const iZ = [21,19,1,21,19,9,19,17,14,19,17,7,17,15,12,17,15,5,15,13,10,15,13,3,13,11,8,13,11,1,11,9,6,11,9,14,9,7,4,9,7,12,7,5,2,7,5,10,5,3,0,5,3,8,3,1,5,3,1,6,1,14,3,1,22,4,22,12,1,22,20,2]

/** The nine IMBE frames of an LDU, from its information dibits. */
export function imbeFrames(dibits: ArrayLike<number>): ImbeFrame[] {
  return FRAME_STARTS.map((start) => {
    const fr = newFrame()
    for (let j = 0; j < 72; j++) {
      const d = dibits[start + j]
      fr[iW[j] * 23 + iX[j]] = (d >> 1) & 1
      fr[iY[j] * 23 + iZ[j]] = d & 1
    }
    return fr
  })
}

/**
 * The encryption sync an LDU2 carries, read from its 16 six bit hex words.
 *
 * The words sit in 20 dibit regions after the second through fifth IMBE
 * frames, four to a region, highest word first, as TIA-102.BAAA lays them
 * out and DSD reads them. Reed-Solomon over the words is not applied, so a
 * caller should want the same answer from two LDU2s before acting on it.
 */

/** The dibit position where each of the 16 hex words (15 down to 0) begins. */
const HEX_WORD_AT: number[] = (() => {
  const at: number[] = []
  // regions after frames 1..4, each holding four words of five dibits.
  for (let k = 1; k <= 4; k++) {
    const base = [0, 72, 164, 256, 348][k] + 72
    for (let w = 0; w < 4; w++) at.push(base + w * 5)
  }
  return at // at[0] is word 15, at[15] is word 0.
})()

/** The six bit value of hex word `w` (0 to 15), from its three data dibits. */
function hexWord(dibits: ArrayLike<number>, w: number): number {
  const p = HEX_WORD_AT[15 - w]
  return ((dibits[p] & 3) << 4) | ((dibits[p + 1] & 3) << 2) | (dibits[p + 2] & 3)
}

export interface EncryptionSync {
  /** The cipher, 0x80 for clear. */
  algid: number
  /** The key the talker used, which the listener needs the value of. */
  keyId: number
  /** The 72 bit message indicator, nine bytes, which seeds the keystream. */
  mi: Uint8Array
}

export function ldu2Sync(dibits: ArrayLike<number>): EncryptionSync {
  const mi = new Uint8Array(9)
  // words 15 down to 4 are the 72 bit mi, six bits each, most significant first.
  const bits: number[] = []
  for (let w = 15; w >= 4; w--) {
    const v = hexWord(dibits, w)
    for (let b = 5; b >= 0; b--) bits.push((v >> b) & 1)
  }
  for (let i = 0; i < 9; i++) {
    let byte = 0
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i * 8 + b]
    mi[i] = byte
  }
  const word3 = hexWord(dibits, 3)
  const word2 = hexWord(dibits, 2)
  const word1 = hexWord(dibits, 1)
  const word0 = hexWord(dibits, 0)
  const algid = ((word3 << 2) | (word2 >> 4)) & 0xff
  const keyId = (((word2 & 0xf) << 12) | (word1 << 6) | word0) & 0xffff
  return { algid, keyId, mi }
}

/** The cipher an LDU2 names, 0x80 for clear voice. */
export function ldu2Algid(dibits: ArrayLike<number>): number {
  return ldu2Sync(dibits).algid
}

export const ALGID_CLEAR = 0x80

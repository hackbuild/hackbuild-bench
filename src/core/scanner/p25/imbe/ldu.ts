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

/** Where the encryption sync's words start in an LDU2: after the fifth IMBE frame. */
const ES_WORDS_AT = 420

/**
 * The encryption algorithm an LDU2 names, 0x80 for clear voice. It sits in
 * the first six bits of one link word and the first two of the next, read
 * here without the word's Hamming check, so a caller should want the same
 * answer twice before acting on it.
 */
export function ldu2Algid(dibits: ArrayLike<number>): number {
  const a = ES_WORDS_AT
  const b = ES_WORDS_AT + 5
  return ((dibits[a] & 3) << 6) | ((dibits[a + 1] & 3) << 4) | ((dibits[a + 2] & 3) << 2) | (dibits[b] & 3)
}

export const ALGID_CLEAR = 0x80

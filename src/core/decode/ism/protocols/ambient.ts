/**
 * Ambient Weather F007TH and F012TH, TFA 30.3208.02, SwitchDoc Labs F016TH.
 *
 * Ported from rtl_433 src/devices/ambient_weather.c (GPL-2.0-or-later).
 * Manchester coded, three repeats with no gap, a 12 bit preamble, then six
 * bytes closed by an LFSR digest (gen 0x98, key 0x3e, xor 0x64).
 */

import { f32mul, lfsrDigest8, round3 } from '../checks'
import type { BitBuffer } from '../bitbuffer'
import type { IsmMessage, IsmProtocol } from '../types'

const PREAMBLE = [0x01, 0x45]
const PREAMBLE_INVERTED = [0xfd, 0x45]

function decodeAt(bits: BitBuffer, row: number, pos: number): IsmMessage | number {
  const b = bits.extractBytes(row, pos, 48)
  if ((lfsrDigest8(b, 5, 0x98, 0x3e) ^ 0x64) !== b[5]) return -2
  const humidity = b[4]
  const tempRaw = ((b[2] & 0x0f) << 8) | b[3]
  const tempF = f32mul(tempRaw - 400, 0.1)
  if (humidity > 100) return -4
  if (tempF < -40 || tempF >= 344) return -4
  return {
    model: 'Ambientweather-F007TH',
    fields: {
      id: b[1],
      channel: ((b[2] & 0x70) >> 4) + 1,
      battery_ok: b[2] & 0x80 ? 0 : 1,
      temperature_F: round3(tempF),
      humidity,
      mic: 'CRC',
    },
    bytes: b,
  }
}

export const ambientF007th: IsmProtocol = {
  id: 'ambient_weather',
  name: 'Ambient Weather F007TH',
  modulation: 'ook_manchester',
  shortUs: 500,
  longUs: 0,
  resetUs: 2400,
  decode(bits, emit) {
    let ret = 0
    for (let row = 0; row < bits.numRows; row++) {
      for (const [pattern, step] of [
        [PREAMBLE, 16],
        [PREAMBLE_INVERTED, 15],
      ] as const) {
        let pos = 0
        while ((pos = bits.search(row, pos, pattern, 12)) + 8 + 48 <= bits.bits[row]) {
          const r = decodeAt(bits, row, pos + 8)
          if (typeof r !== 'number') {
            emit(r)
            return 1
          }
          ret = r
          pos += step
        }
      }
    }
    return ret
  },
}

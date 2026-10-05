/**
 * LaCrosse TX141 family: TX141-Bv2, TX141TH-Bv2, TX141-Bv3, TX141B, TX141W
 * and TX145wsdth.
 *
 * Ported from rtl_433 src/devices/lacrosse_tx141x.c (GPL-2.0-or-later). The
 * row is sent many times, so the decoder takes the row that repeats. Only
 * the TH and W variants carry an integrity check: an LFSR digest on the TH
 * and a CRC-8 on the W.
 */

import { crc8, f32mul, lfsrDigest8Reflect, round3 } from '../checks'
import type { IsmProtocol } from '../types'

export const lacrosseTx141: IsmProtocol = {
  id: 'lacrosse_tx141x',
  name: 'LaCrosse TX141 family',
  modulation: 'ook_pwm',
  shortUs: 208,
  longUs: 417,
  syncUs: 833,
  gapUs: 625,
  resetUs: 1700,
  decode(bits, emit) {
    let r = bits.findRepeatedRow(bits.numRows > 5 ? 5 : 3, 32)
    if (r < 0) r = bits.findRepeatedRow(2, 64)
    if (r < 0) return -1

    const n = bits.bits[r]
    let kind: 'W' | 'TH' | 'Bv2' | 'B' | 'Bv3'
    if (n >= 64) kind = 'W'
    else if (n > 41) return -1
    else if (n >= 41) {
      // 41 bit rows in long bursts come from a GT-WT-03.
      if (bits.numRows > 12) return -1
      kind = 'TH'
    } else if (n >= 40) kind = 'TH'
    else if (n >= 37) kind = 'Bv2'
    else if (n === 32) kind = 'B'
    else kind = 'Bv3'

    bits.invert()
    const b = bits.rows[r]

    if (kind === 'W') {
      if (b[0] >> 3 !== 0x01) return -3
      if (crc8(b, 8, 0x31, 0x00)) return -2
      const id = ((b[0] & 0x07) << 16) | (b[1] << 8) | b[2]
      const batteryLow = b[3] >> 7
      const test = (b[3] & 0x40) >> 6
      const channel = (b[3] & 0x30) >> 4
      const type = b[3] & 0x0f
      const raw = (b[4] << 4) | (b[5] >> 4)
      const low = ((b[5] & 0x0f) << 8) | b[6]
      if (type === 1) {
        emit({
          model: 'LaCrosse-TX141W',
          fields: {
            id,
            channel,
            battery_ok: batteryLow ? 0 : 1,
            temperature_C: round3(f32mul(raw - 500, 0.1)),
            humidity: low,
            test,
            mic: 'CRC',
          },
          bytes: b.slice(0, 8),
        })
      } else if (type === 2) {
        emit({
          model: 'LaCrosse-TX141W',
          fields: {
            id,
            channel,
            battery_ok: batteryLow ? 0 : 1,
            wind_avg_km_h: round3(f32mul(raw, 0.1)),
            wind_dir_deg: low,
            test,
            mic: 'CRC',
          },
          bytes: b.slice(0, 8),
        })
      } else {
        return -5
      }
      return 1
    }

    const id = b[0]
    const batteryLow = kind === 'TH' ? b[1] >> 7 : b[1] >> 7 ? 0 : 1
    const test = (b[1] & 0x40) >> 6 ? 'Yes' : 'No'
    const channel = (b[1] & 0x30) >> 4
    const temp = f32mul((((b[1] & 0x0f) << 8) | b[2]) - 500, 0.1)
    const humidity = kind === 'TH' ? b[3] : 0
    if (id === 0 || (kind === 'TH' && (humidity === 0 || humidity > 100)) || temp < -40 || temp > 140) return -4

    const battery_ok = batteryLow ? 0 : 1
    const temperature_C = round3(temp)
    if (kind === 'B') {
      emit({ model: 'LaCrosse-TX141B', fields: { id, temperature_C, battery_ok, test }, bytes: b.slice(0, 4) })
    } else if (kind === 'Bv2') {
      emit({ model: 'LaCrosse-TX141Bv2', fields: { id, channel, temperature_C, battery_ok, test }, bytes: b.slice(0, 5) })
    } else if (kind === 'Bv3') {
      emit({ model: 'LaCrosse-TX141Bv3', fields: { id, channel, battery_ok, temperature_C, test }, bytes: b.slice(0, 5) })
    } else {
      if (lfsrDigest8Reflect(b, 4, 0x31, 0xf4) !== b[4]) return -2
      emit({
        model: 'LaCrosse-TX141THBv2',
        fields: { id, channel, battery_ok, temperature_C, humidity, test, mic: 'CRC' },
        bytes: b.slice(0, 5),
      })
    }
    return 1
  },
}

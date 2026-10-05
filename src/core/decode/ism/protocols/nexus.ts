/**
 * Nexus and Prologue temperature sensors, and their many rebrands (FreeTec,
 * Solight, TFA 30.3209, Technoline, ThermoPro TX2).
 *
 * Ported from rtl_433 src/devices/nexus.c and prologue.c
 * (GPL-2.0-or-later). Both send a 36 bit row several times in PPM and carry
 * no checksum, so a row has to repeat before it counts. They run after the
 * protocols that do check their data, as in rtl_433.
 */

import { f32mul, round3 } from '../checks'
import type { IsmMessage, IsmProtocol } from '../types'

export const nexus: IsmProtocol = {
  id: 'nexus',
  name: 'Nexus temperature and humidity',
  modulation: 'ook_ppm',
  shortUs: 1000,
  longUs: 2000,
  gapUs: 3000,
  resetUs: 5000,
  priority: 10,
  decode(bits, emit) {
    const r = bits.findRepeatedRow(3, 36)
    if (r < 0) return -3
    const b = bits.rows[r]
    if (bits.bits[r] > 37) return -1
    if ((b[3] & 0xf0) !== 0xf0) return -3
    if ((b[0] === 0 && b[2] === 0 && b[3] === 0) || (b[0] === 0xff && b[2] === 0xff && b[3] === 0xff)) return -3
    if ((b[1] & 0x30) === 0x30) return -3
    const test = b[1] & 0x40
    const raw = (((b[1] << 12) | (b[2] << 4)) << 16) >> 16
    const tempC = f32mul(raw >> 4, 0.1)
    const humidity = ((b[3] & 0x0f) << 4) | (b[4] >> 4)
    const fields: IsmMessage['fields'] = {
      id: b[0],
      channel: ((b[1] & 0x30) >> 4) + 1,
      battery_ok: b[1] & 0x80 ? 1 : 0,
      temperature_C: round3(tempC),
    }
    if (humidity) fields.humidity = humidity
    if (test) fields.test = 1
    emit({ model: humidity ? 'Nexus-TH' : 'Nexus-T', fields, bytes: b.slice(0, 5) })
    return 1
  },
}

export const prologue: IsmProtocol = {
  id: 'prologue',
  name: 'Prologue temperature sensor',
  modulation: 'ook_ppm',
  shortUs: 2000,
  longUs: 4000,
  gapUs: 7000,
  resetUs: 10000,
  priority: 10,
  decode(bits, emit) {
    // an 8 bit sync row means an Alecto or Auriol, which this would misread.
    if (bits.bits[0] <= 8 && bits.bits[0] !== 0) return -3
    const r = bits.findRepeatedRow(4, 36)
    if (r < 0) return -3
    if (bits.bits[r] > 37) return -1
    const b = bits.rows[r]
    if ((b[0] & 0xf0) !== 0x90 && (b[0] & 0xf0) !== 0x50) return -4
    const raw = ((((b[2] << 8) | (b[3] & 0xf0)) << 16) >> 16) >> 4
    const humidity = ((b[3] & 0x0f) << 4) | (b[4] >> 4)
    const fields: IsmMessage['fields'] = {
      subtype: b[0] >> 4,
      id: ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4),
      channel: (b[1] & 0x03) + 1,
      battery_ok: b[1] & 0x08 ? 1 : 0,
      temperature_C: round3(raw * 0.1),
    }
    if (humidity !== 0xcc) fields.humidity = humidity
    fields.button = (b[1] & 0x04) >> 2
    emit({ model: 'Prologue-TH', fields, bytes: b.slice(0, 5) })
    return 1
  },
}

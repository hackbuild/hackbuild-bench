/**
 * Acurite 592TXR tower, 5-in-1, 3-in-1, 515 and 899 sensors.
 *
 * Ported from rtl_433 src/devices/acurite.c, acurite_txr_decode
 * (GPL-2.0-or-later). These share one frame: channel and id in the first two
 * bytes, a message type in the low six bits of the third, even parity on
 * every byte between the id and the checksum, and an 8 bit sum at the end.
 * The Atlas, 6045M and 1190 types of the same family are recognised by the
 * check but not decoded here.
 */

import { addBytes, f32mul, parityBytes, round3 } from '../checks'
import type { IsmMessage, IsmProtocol } from '../types'

const TYPE_TOWER = 0x04
const TYPE_515_FRIDGE = 0x08
const TYPE_515_FREEZER = 0x09
const TYPE_3N1 = 0x20
const TYPE_899 = 0x30
const TYPE_5N1_WIND_RAIN = 0x31
const TYPE_5N1_WIND_TEMP = 0x38

const KNOWN = new Set([0x01, 0x04, 0x2f, 0x31, 0x38, 0x05, 0x06, 0x07, 0x25, 0x26, 0x27, 0x08, 0x09, 0x20, 0x30])

/** Indexed by the raw nibble, in units of 22.5 degrees. The order is the sensor's. */
const WIND_DIRS = [14, 11, 13, 12, 15, 10, 0, 9, 3, 6, 4, 5, 2, 7, 1, 8]

function channelOf(b0: number): string {
  return ['C', 'E', 'B', 'A'][(b0 & 0xc0) >> 6]
}

/** Zero when the row is good for a message `len` bytes long. */
function check(bb: Uint8Array, rowBytes: number, len: number): number {
  if (rowBytes < 6 || rowBytes < len) return -1
  if ((addBytes(bb, len - 1) & 0xff) !== bb[len - 1]) return -2
  if (parityBytes(bb, len - 3, 2)) return -2
  if (channelOf(bb[0]) === 'E') return -4
  return 0
}

function tower(bb: Uint8Array, out: IsmMessage[]): number {
  const id = ((bb[0] & 0x3f) << 8) | bb[1]
  const humidity = bb[3] & 0x7f
  if (humidity > 100 && humidity !== 127) return -4
  const tempRaw = ((bb[4] & 0x7f) << 7) | (bb[5] & 0x7f)
  const tempC = f32mul(tempRaw - 1000, 0.1)
  if (tempC < -40 || tempC > 70) return -4
  const fields: IsmMessage['fields'] = {
    id,
    channel: channelOf(bb[0]),
    battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
    temperature_C: round3(tempC),
  }
  if (humidity !== 127) fields.humidity = humidity
  fields.mic = 'CHECKSUM'
  if (tempRaw & 0x3800) {
    fields.exception = 1
    fields.raw_msg = hex(bb, 7)
  }
  out.push({ model: 'Acurite-Tower', fields, bytes: bb.slice(0, 7) })
  return 1
}

function fiveInOne(bb: Uint8Array, out: IsmMessage[]): number {
  const type = bb[2] & 0x3f
  const id = ((bb[0] & 0x0f) << 8) | bb[1]
  const speedRaw = ((bb[3] & 0x1f) << 3) | ((bb[4] & 0x70) >> 4)
  const kmh = speedRaw > 0 ? Math.fround(f32mul(speedRaw, 0.8278) + 1) : 0
  const head = {
    message_type: type,
    id,
    channel: channelOf(bb[0]),
    sequence_num: (bb[0] & 0x30) >> 4,
    battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
    wind_avg_km_h: round3(kmh),
  }
  if (type === TYPE_5N1_WIND_RAIN) {
    const dir = f32mul(WIND_DIRS[bb[4] & 0x0f], 22.5)
    const rain = ((bb[5] & 0x7f) << 7) | (bb[6] & 0x7f)
    out.push({
      model: 'Acurite-5n1',
      fields: { ...head, wind_dir_deg: round3(dir), rain_in: round3(f32mul(rain, 0.01)), mic: 'CHECKSUM' },
      bytes: bb.slice(0, 8),
    })
    return 1
  }
  const tempRaw = ((bb[4] & 0x0f) << 7) | (bb[5] & 0x7f)
  const tempF = f32mul(tempRaw - 400, 0.1)
  if (tempF < -40 || tempF > 158) return -4
  const humidity = bb[6] & 0x7f
  if (humidity > 100) return -4
  out.push({
    model: 'Acurite-5n1',
    fields: { ...head, temperature_F: round3(tempF), humidity, mic: 'CHECKSUM' },
    bytes: bb.slice(0, 8),
  })
  return 1
}

function threeInOne(bb: Uint8Array, out: IsmMessage[]): number {
  const channel = channelOf(bb[0])
  if (channel === 'E') return -4
  const humidity = bb[3] & 0x7f
  if (humidity > 100) return -4
  const tempRaw = ((bb[4] & 0x1f) << 7) | (bb[5] & 0x7f)
  const tempF = f32mul(tempRaw - 1480, 0.1)
  if (tempF < -40 || tempF > 158) return -4
  out.push({
    model: 'Acurite-3n1',
    fields: {
      message_type: bb[2] & 0x3f,
      id: ((bb[0] & 0x3f) << 8) | bb[1],
      channel,
      sequence_num: (bb[0] & 0x30) >> 4,
      battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
      wind_avg_mi_h: bb[6] & 0x7f,
      temperature_F: round3(tempF),
      humidity,
      mic: 'CHECKSUM',
    },
    bytes: bb.slice(0, 8),
  })
  return 1
}

function fridge(bb: Uint8Array, out: IsmMessage[]): number {
  const type = bb[2] & 0x3f
  const channel = channelOf(bb[0]) + (type === TYPE_515_FRIDGE ? 'R' : 'F')
  const tempRaw = ((bb[3] & 0x7f) << 7) | (bb[4] & 0x7f)
  const tempF = f32mul(tempRaw - 1480, 0.1)
  if (tempF < -40 || tempF > 158) return -4
  const fields: IsmMessage['fields'] = {
    id: ((bb[0] & 0x3f) << 8) | bb[1],
    channel,
    battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
    temperature_F: round3(tempF),
    mic: 'CHECKSUM',
  }
  if (tempRaw & 0x3000) {
    fields.exception = 1
    fields.raw_msg = hex(bb, 6)
  }
  out.push({ model: 'Acurite-515', fields, bytes: bb.slice(0, 6) })
  return 1
}

function rain899(bb: Uint8Array, out: IsmMessage[]): number {
  const rain = ((bb[5] & 0x7f) << 7) | (bb[6] & 0x7f)
  out.push({
    model: 'Acurite-Rain899',
    fields: {
      id: ((bb[0] & 0x3f) << 8) | bb[1],
      channel: bb[0] >> 6,
      battery_ok: (bb[2] & 0x40) === 0 ? 0 : 1,
      rain_mm: round3(rain * 0.254),
      mic: 'CHECKSUM',
    },
    bytes: bb.slice(0, 8),
  })
  return 1
}

function hex(b: Uint8Array, n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

export const acuriteTxr: IsmProtocol = {
  id: 'acurite',
  name: 'Acurite 592TXR tower, 5-in-1, 3-in-1, 515, 899',
  modulation: 'ook_pwm',
  shortUs: 220,
  longUs: 408,
  syncUs: 620,
  gapUs: 500,
  resetUs: 4000,
  decode(bits, emit) {
    bits.invert()
    let decoded = 0
    let error = 0
    const out: IsmMessage[] = []
    for (let r = 0; r < bits.numRows; r++) {
      const rowBytes = bits.bits[r] >> 3
      const bb = bits.rows[r]
      if (rowBytes < 6) continue
      if (rowBytes > 10) {
        error = -1
        continue
      }
      if (bb[0] === 0 && bb[1] === 0 && bb[2] === 0 && bb[rowBytes - 1] === 0) continue
      const type = bb[2] & 0x3f
      if (!KNOWN.has(type)) {
        error = -4
        continue
      }
      let ret = 0
      if (type === TYPE_TOWER) {
        ret = check(bb, rowBytes, 7) || tower(bb, out)
      } else if (type === TYPE_515_FRIDGE || type === TYPE_515_FREEZER) {
        ret = check(bb, rowBytes, 6) || fridge(bb, out)
      } else if (type === TYPE_5N1_WIND_RAIN || type === TYPE_5N1_WIND_TEMP) {
        ret = check(bb, rowBytes, 8) || fiveInOne(bb, out)
      } else if (type === TYPE_3N1) {
        // the 3-in-1 carries no parity, only the sum.
        if (rowBytes < 8) ret = -1
        else if ((addBytes(bb, 7) & 0xff) !== bb[7]) ret = -2
        else ret = threeInOne(bb, out)
      } else if (type === TYPE_899) {
        ret = check(bb, rowBytes, 8) || rain899(bb, out)
      }
      if (ret > 0) decoded += ret
      else if (ret < 0) error = ret
    }
    for (const m of out) emit(m)
    return decoded > 0 ? decoded : error
  },
}

/**
 * Fine Offset Electronics sensors: WH2, WH2A, WH5 and Telldus on OOK, and
 * the FSK family of WH24, WH65B, WH25 and WH32.
 *
 * Ported from rtl_433 src/devices/fineoffset.c (GPL-2.0-or-later). The OOK
 * sensors close with a CRC-8 (poly 0x31). The WH24 and WH65B close with the
 * same CRC over 15 bytes plus an 8 bit sum, and the WH25 and WH32 with a sum
 * and a nibble swapped xor.
 */

import { addBytes, crc8, f32mul, round3, xorBytes } from '../checks'
import type { BitBuffer } from '../bitbuffer'
import type { IsmMessage, IsmProtocol } from '../types'

export const fineoffsetWh2: IsmProtocol = {
  id: 'fineoffset_wh2',
  name: 'Fine Offset WH2, WH2A, WH5, Telldus',
  modulation: 'ook_pwm',
  shortUs: 500,
  longUs: 1500,
  resetUs: 1200,
  toleranceUs: 160,
  decode(bits, emit) {
    const bb = bits.rows[0]
    const n = bits.bits[0]
    let b: Uint8Array
    let model: string
    if (n === 48 && bb[0] === 0xff) {
      b = bits.extractBytes(0, 8, 40)
      model = 'Fineoffset-WH2'
    } else if (n === 55 && bb[0] === 0xfe) {
      b = bits.extractBytes(0, 7, 48)
      model = 'Fineoffset-WH2A'
    } else if (n === 47 && bb[0] === 0xfe) {
      b = bits.extractBytes(0, 7, 40)
      model = 'Fineoffset-WH5'
    } else if (n === 49 && bb[0] === 0xff && (bb[1] & 0x80) === 0x80) {
      b = bits.extractBytes(0, 9, 40)
      model = 'Fineoffset-TelldusProove'
    } else {
      return -1
    }
    if (b[4] !== crc8(b, 4, 0x31, 0)) return -2
    if (b[0] >> 4 !== 4) return -4
    const id = ((b[0] & 0x0f) << 4) | ((b[1] & 0xf0) >> 4)
    let temp = ((b[1] & 0x0f) << 8) | b[2]
    if (n !== 47) {
      // sign and magnitude
      if (temp & 0x800) temp = -(temp & 0x7ff)
    } else {
      temp -= 400
    }
    const fields: IsmMessage['fields'] = { id, temperature_C: round3(f32mul(temp, 0.1)) }
    if (b[3] !== 0xff) fields.humidity = b[3]
    fields.mic = 'CRC'
    emit({ model, fields, bytes: b.slice(0, 5) })
    return 1
  },
}

const SYNC = [0xaa, 0x2d, 0xd4]
const UVI_UPPER = [432, 851, 1210, 1570, 2017, 2450, 2761, 3100, 3512, 3918, 4277, 4650, 5029]

function wh24(bits: BitBuffer): IsmMessage | number {
  const n = bits.bits[0]
  if (n < 190 || n > 215) return -1
  const off = bits.search(0, 0, SYNC, 24) + 24
  if (off + 17 * 8 > n) return -1
  // the WH65B sends a longer preamble and postamble around the same payload.
  const wh24 = n - off - 17 * 8 < 8 && off < 61
  const b = bits.extractBytes(0, off, 17 * 8)
  if (b[0] !== 0x24) return -4
  const crc = crc8(b, 15, 0x31, 0)
  const sum = addBytes(b, 16) & 0xff
  if (crc !== b[15] || sum !== b[16]) return -2

  const windDir = b[2] | ((b[3] & 0x80) << 1)
  const lowBattery = (b[3] & 0x08) >> 3
  const tempRaw = ((b[3] & 0x07) << 8) | b[4]
  const humidity = b[5]
  const windRaw = b[6] | ((b[3] & 0x10) << 4)
  const factor = wh24 ? 1.12 : 0.51
  const cup = wh24 ? 0.3 : 0.254
  const gustRaw = b[7]
  const rainRaw = (b[8] << 8) | b[9]
  const uvRaw = (b[10] << 8) | b[11]
  const lightRaw = (b[12] << 16) | (b[13] << 8) | b[14]
  let uvi = 0
  while (uvi < 13 && UVI_UPPER[uvi] < uvRaw) uvi++

  const fields: IsmMessage['fields'] = { id: b[1], battery_ok: lowBattery ? 0 : 1 }
  if (tempRaw !== 0x7ff) fields.temperature_C = round3(f32mul(tempRaw - 400, 0.1))
  if (humidity !== 0xff) fields.humidity = humidity
  if (windDir !== 0x1ff) fields.wind_dir_deg = windDir
  if (windRaw !== 0x1ff) fields.wind_avg_m_s = round3(f32mul(f32mul(windRaw, 0.125), factor))
  if (gustRaw !== 0xff) fields.wind_max_m_s = round3(f32mul(gustRaw, factor))
  fields.rain_mm = round3(f32mul(rainRaw, cup))
  if (uvRaw !== 0xffff) {
    fields.uv = uvRaw
    fields.uvi = uvi
  }
  if (lightRaw !== 0xffffff) fields.light_lux = round3(lightRaw * 0.1)
  fields.mic = 'CRC'
  return { model: wh24 ? 'Fineoffset-WH24' : 'Fineoffset-WH65B', fields, bytes: b }
}

function wh25(bits: BitBuffer): IsmMessage | number {
  const n = bits.bits[0]
  let type = 25
  // the WH0290 air quality sensor shares this framing and is not decoded here.
  if (n < 160) return -3
  if (n < 190) type = 32
  else if (n < 440) return wh24(bits)
  if (n > 510) type = 32
  const off = bits.search(0, 0, SYNC, 24) + 24
  if (off + 64 > n) return -1
  const b = bits.extractBytes(0, off, 64)
  const msgType = b[0] & 0xf0
  if (type === 32 && msgType === 0xd0) type = 31
  else if (msgType !== 0xe0) return -3
  if ((addBytes(b, 6) & 0xff) - b[6]) return -2
  let bitsum = xorBytes(b, 6)
  bitsum = ((bitsum & 0x0f) << 4) | (bitsum >> 4)
  if (type === 25 && bitsum !== b[7]) return -2

  const pressureRaw = (b[4] << 8) | b[5]
  const fields: IsmMessage['fields'] = {
    id: ((b[0] & 0x0f) << 4) | (b[1] >> 4),
    battery_ok: (b[1] & 0x08) >> 3 ? 0 : 1,
    temperature_C: round3(f32mul((((b[1] & 0x03) << 8) | b[2]) - 400, 0.1)),
    humidity: b[3],
  }
  if (pressureRaw !== 0xffff) fields.pressure_hPa = round3(f32mul(pressureRaw, 0.1))
  fields.mic = 'CRC'
  const model = type === 31 ? 'Fineoffset-WH32' : type === 32 ? 'Fineoffset-WH32B' : 'Fineoffset-WH25'
  return { model, fields, bytes: b }
}

export const fineoffsetWh25: IsmProtocol = {
  id: 'fineoffset_wh25',
  name: 'Fine Offset WH24, WH65B, WH25, WH32',
  modulation: 'fsk_pcm',
  shortUs: 58,
  longUs: 58,
  resetUs: 20000,
  decode(bits, emit) {
    const r = wh25(bits)
    if (typeof r === 'number') return r
    emit(r)
    return 1
  },
}

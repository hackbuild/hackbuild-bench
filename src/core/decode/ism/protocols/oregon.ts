/**
 * Oregon Scientific v2.1 and v3 weather sensors.
 *
 * Ported from rtl_433 src/devices/oregon_scientific.c (GPL-2.0-or-later).
 * v2.1 sends every bit twice, inverted, so the raw row is manchester decoded
 * after a sync search. v3 is plain manchester. Both carry nibble reflected
 * BCD readings and a sum of nibbles checksum. The energy meters that share
 * v3 (CM160, CM180) are left out.
 */

import { reflectNibbles, round3 } from '../checks'
import { BitBuffer } from '../bitbuffer'
import type { IsmMessage, IsmProtocol } from '../types'

const ID_THGR122N = 0x1d20
const ID_THGR968 = 0x1d30
const ID_BTHR918 = 0x5d50
const ID_BHTR968 = 0x5d60
const ID_RGR968 = 0x2d10
const ID_THR228N = 0xec40
const ID_THN132N = 0xec40
const ID_AWR129 = 0xec41
const ID_RTGN318 = 0x0cc3
const ID_RTGN129 = 0x0cc3
const ID_THGR810 = 0xf024
const ID_THGR810A = 0xf8b4
const ID_THN802 = 0xc844
const ID_PCR800 = 0x2914
const ID_PCR800A = 0x2d14
const ID_WGR800 = 0x1984
const ID_WGR800A = 0x1994
const ID_WGR968 = 0x3d00
const ID_UV800 = 0xd874
const ID_THN129 = 0xcc43
const ID_RTHN129 = 0x0cd3
const ID_BTHGN129 = 0x5d53
const ID_UVR128 = 0xec70
const ID_THGR328N = 0xcc23
const RTGR328N = new Set([0xdcc3, 0xccc3, 0xbcc3, 0xacc3, 0x9cc3])

const F = Math.fround

function temperature(m: Uint8Array): number {
  let t = F(F((m[5] >> 4) * 100 + (m[4] & 0x0f) * 10 + ((m[4] >> 4) & 0x0f)) / 10)
  t = F(t + F((m[5] & 0x07) * 100))
  return m[5] & 0x08 ? -t : t
}

function humidity(m: Uint8Array): number {
  return (m[6] & 0x0f) * 10 + (m[6] >> 4)
}

function uv(m: Uint8Array): number {
  return (m[4] & 0x0f) * 10 + (m[4] >> 4)
}

function checksumOk(m: Uint8Array, idx: number): boolean {
  let sum = 0
  for (let i = 0; i < idx - 1; i += 2) {
    const v = m[i >> 1]
    sum += (v >> 4) + (v & 0x0f)
  }
  let check: number
  if (idx & 1) {
    sum += m[idx >> 1] >> 4
    check = (m[idx >> 1] & 0x0f) | (m[(idx + 1) >> 1] & 0xf0)
  } else {
    check = (m[idx >> 1] >> 4) | ((m[idx >> 1] & 0x0f) << 4)
  }
  return (sum & 0xff) === check
}

function v2Ok(m: Uint8Array, expected: number, got: number, nibbles: number): boolean {
  return expected === got && checksumOk(m, nibbles)
}

function bcdOk(...nibbles: number[]): boolean {
  return nibbles.every((n) => n <= 9)
}

interface Head {
  id: number
  channel: number
  battery_ok: number
}

function head(m: Uint8Array): Head {
  return {
    id: (m[2] & 0x0f) | (m[3] & 0xf0),
    channel: (m[2] >> 4) & 0x0f,
    battery_ok: (m[3] >> 2) & 1 ? 0 : 1,
  }
}

function msg(model: string, fields: IsmMessage['fields'], m: Uint8Array, bits: number): IsmMessage {
  return { model, fields, bytes: m.slice(0, (bits + 7) >> 3) }
}

function v21(bits: BitBuffer): IsmMessage | number {
  const b = bits.rows[0]
  if ((b[1] !== 0x55 || b[2] !== 0x55) && (b[1] !== 0xaa || b[2] !== 0xaa)) return -3

  const data = new BitBuffer()
  const test = ((b[3] << 24) | (b[4] << 16) | (b[5] << 8) | b[6]) >>> 0
  for (let i = 0; i < 8; i++) {
    const mask = (0xffff0000 >>> i) >>> 0
    if (((test & mask) >>> 0) !== (0x55990000 >>> i) >>> 0 && ((test & mask) >>> 0) !== (0xaa990000 >>> i) >>> 0) continue
    bits.manchesterDecode(0, i + 40, data, 173)
    break
  }
  const m = data.rows[0] ?? new Uint8Array(64)
  const nbits = data.bits[0] ?? 0
  reflectNibbles(m, (nbits + 7) >> 3)

  const sensor = (m[0] << 8) | m[1]
  const h = head(m)
  const t = (): number => round3(temperature(m))

  if (sensor === ID_THGR122N || sensor === ID_THGR968) {
    if (!v2Ok(m, 68, nbits, 15) && !v2Ok(m, 76, nbits, 15)) return 0
    let model = ''
    if (sensor === ID_THGR968) model = 'Oregon-THGR968'
    else if (nbits === 76) model = 'Oregon-THGR122N'
    else if (nbits === 68) model = 'Oregon-THGR228N'
    return msg(model, { ...h, temperature_C: t(), humidity: humidity(m) }, m, nbits)
  }
  if (sensor === ID_WGR968) {
    if (!v2Ok(m, 94, nbits, 17)) return 0
    const dir = F((m[4] & 0x0f) * 10 + ((m[4] >> 4) & 0x0f) + ((m[5] >> 4) & 0x0f) * 100)
    const avg = F(F(F(F(((m[7] >> 4) & 0x0f) / 10) + F(m[7] & 0x0f)) + F(((m[8] >> 4) & 0x0f) / 10)))
    const gust = F(F(F((m[5] & 0x0f) / 10) + F((m[6] >> 4) & 0x0f)) + F((m[6] & 0x0f) / 10))
    return msg('Oregon-WGR968', { ...h, wind_max_m_s: round3(gust), wind_avg_m_s: round3(avg), wind_dir_deg: round3(dir) }, m, nbits)
  }
  if (sensor === ID_BHTR968 || sensor === ID_BTHR918) {
    const isBhtr = sensor === ID_BHTR968
    if (!v2Ok(m, isBhtr ? 92 : 84, nbits, 19)) return 0
    const pressure = ((m[7] & 0x0f) | (m[8] & 0xf0)) + (isBhtr ? 856 : 795)
    return msg(
      isBhtr ? 'Oregon-BHTR968' : 'Oregon-BTHR918',
      { ...h, temperature_C: t(), humidity: humidity(m), pressure_hPa: pressure },
      m,
      nbits,
    )
  }
  if (sensor === ID_RGR968) {
    if (!v2Ok(m, 80, nbits, 16)) return 0
    const rate = F(((m[4] & 0x0f) * 100 + (m[4] >> 4) * 10 + ((m[5] >> 4) & 0x0f)) / 10)
    const total = F(((m[7] & 0xf) * 10000 + (m[7] >> 4) * 1000 + (m[6] & 0xf) * 100 + (m[6] >> 4) * 10 + (m[5] & 0xf)) / 10)
    return msg('Oregon-RGR968', { ...h, rain_rate_mm_h: round3(rate), rain_mm: round3(total) }, m, nbits)
  }
  if ((sensor === ID_THR228N || sensor === ID_AWR129) && nbits === 76) {
    if (!v2Ok(m, 76, nbits, 12)) return 0
    return msg(sensor === ID_THR228N ? 'Oregon-THR228N' : 'Oregon-AWR129', { ...h, temperature_C: t() }, m, nbits)
  }
  if (sensor === ID_THN132N && nbits === 64) {
    if (!v2Ok(m, 64, nbits, 12)) return 0
    if (!bcdOk((m[5] >> 4) & 0x0f, m[4] & 0x0f, (m[4] >> 4) & 0x0f)) return -4
    const c = temperature(m)
    if (c > 70 || c < -50) return -4
    return msg('Oregon-THN132N', { ...h, temperature_C: round3(c) }, m, nbits)
  }
  if ((sensor & 0x0fff) === ID_RTGN129 && nbits === 80) {
    if (!v2Ok(m, 80, nbits, 15)) return 0
    return msg('Oregon-RTGN129', { ...h, temperature_C: t(), humidity: humidity(m) }, m, nbits)
  }
  if (RTGR328N.has(sensor) && nbits === 173) {
    if (!v2Ok(m, 173, nbits, 15)) return 0
    return msg('Oregon-RTGR328N', { ...h, temperature_C: t(), humidity: humidity(m) }, m, nbits)
  }
  if ((sensor & 0x0fff) === ID_RTGN318) {
    if (nbits === 76 && v2Ok(m, 76, nbits, 15)) {
      return msg('Oregon-RTGN318', { ...h, temperature_C: t(), humidity: humidity(m) }, m, nbits)
    }
    return 0
  }
  if (sensor === ID_THN129 || (sensor & 0x0fff) === ID_RTHN129) {
    if (v2Ok(m, 68, nbits, 12)) {
      return msg(sensor === ID_THN129 ? 'Oregon-THN129' : 'Oregon-RTHN129', { ...h, temperature_C: t() }, m, nbits)
    }
    return 0
  }
  if (sensor === ID_BTHGN129) {
    if (!v2Ok(m, 92, nbits, 19)) return 0
    const pressure = ((m[7] & 0x0f) | (m[8] & 0xf0)) * 2 + (m[8] & 0x01) + 600
    return msg('Oregon-BTHGN129', { ...h, temperature_C: t(), humidity: humidity(m), pressure_hPa: pressure }, m, nbits)
  }
  if (sensor === ID_UVR128 && nbits === 148) {
    if (!v2Ok(m, 148, nbits, 12)) return 0
    if (!bcdOk((m[4] >> 4) & 0x0f, m[4] & 0x0f)) return -4
    const u = uv(m)
    if (u > 25) return -4
    return msg('Oregon-UVR128', { id: h.id, uvi: u, battery_ok: h.battery_ok }, m, nbits)
  }
  if (sensor === ID_THGR328N) {
    if (!v2Ok(m, 173, nbits, 15)) return 0
    return msg('Oregon-THGR328N', { ...h, temperature_C: t(), humidity: humidity(m) }, m, nbits)
  }
  return 0
}

const OS_PATTERN = [0x00, 0x05]
const ALT_PATTERN = [0xff, 0xf5]

function v3(bits: BitBuffer): IsmMessage | number {
  const b = bits.rows[0]
  const n = bits.bits[0]
  if (((b[0] & 0xf) !== 0x0f || b[1] !== 0xff || (b[2] & 0xc0) !== 0xc0) && ((b[0] & 0xf) !== 0x00 || b[1] !== 0x00 || (b[2] & 0xc0) !== 0x00)) {
    return -3
  }
  const osPos = bits.search(0, 0, OS_PATTERN, 16) + 16
  const altPos = bits.search(0, 0, ALT_PATTERN, 16) + 16
  let pos = 0
  let len = 0
  if (n - osPos >= 56) {
    pos = osPos
    len = n - osPos
  } else if (n - altPos >= 56) {
    pos = altPos
    len = n - altPos
  }
  if (len === 0 || len > 44 * 8) return -3
  const m = bits.extractBytes(0, pos, len, new Uint8Array(44))
  reflectNibbles(m, (len + 7) >> 3)

  const sensor = (m[0] << 8) | m[1]
  const h = head(m)

  if ((sensor & 0xf0ff) === ID_THGR810 || sensor === ID_THGR810A) {
    if (!checksumOk(m, 15)) return -2
    if (!bcdOk((m[5] >> 4) & 0x0f, m[4] & 0x0f, (m[4] >> 4) & 0x0f, m[6] & 0x0f, (m[6] >> 4) & 0x0f)) return -4
    const c = temperature(m)
    if (c > 70 || c < -50) return -4
    const button = m[0] & 1
    const fields: IsmMessage['fields'] = { id: h.id, channel: h.channel }
    if (button) fields.button = button
    Object.assign(fields, { battery_ok: h.battery_ok, temperature_C: round3(c), humidity: humidity(m) })
    return msg('Oregon-THGR810', fields, m, len)
  }
  if (sensor === ID_THN802) {
    if (!checksumOk(m, 12)) return -2
    return msg('Oregon-THN802', { ...h, temperature_C: round3(temperature(m)) }, m, len)
  }
  if (sensor === ID_UV800) {
    if (!checksumOk(m, 13)) return -2
    return msg('Oregon-UV800', { ...h, uvi: uv(m) }, m, len)
  }
  if (sensor === ID_PCR800 || sensor === ID_PCR800A) {
    if (!checksumOk(m, 18)) return -2
    if (sensor === ID_PCR800) {
      const nib: number[] = []
      for (let i = 4; i <= 8; i++) nib.push(m[i] & 0x0f, (m[i] >> 4) & 0x0f)
      if (!bcdOk(...nib)) return -4
    }
    const rate = F(((m[5] & 0x0f) * 1000 + (m[5] >> 4) * 100 + (m[4] & 0x0f) * 10 + (m[4] >> 4)) / 100)
    let total = F(F((m[8] & 0x0f) * 100) + F(((m[8] >> 4) & 0x0f) * 10))
    total = F(total + F(m[7] & 0x0f))
    total = F(total + F(((m[7] >> 4) & 0x0f) / 10))
    total = F(total + F((m[6] & 0x0f) / 100))
    total = F(total + F(((m[6] >> 4) & 0x0f) / 1000))
    return msg(
      sensor === ID_PCR800 ? 'Oregon-PCR800' : 'Oregon-PCR800a',
      { ...h, rain_rate_in_h: round3(rate), rain_in: round3(total) },
      m,
      len,
    )
  }
  if (sensor === ID_WGR800 || sensor === ID_WGR800A) {
    if (!checksumOk(m, 17)) return -2
    if (!bcdOk(m[5] & 0x0f, (m[6] >> 4) & 0x0f, m[6] & 0x0f, (m[7] >> 4) & 0x0f, m[7] & 0x0f, (m[8] >> 4) & 0x0f)) return -4
    const gust = F(F(F((m[5] & 0x0f) / 10) + F((m[6] >> 4) & 0x0f)) + F((m[6] & 0x0f) * 10))
    const avg = F(F(F(((m[7] >> 4) & 0x0f) / 10) + F(m[7] & 0x0f)) + F(((m[8] >> 4) & 0x0f) * 10))
    const dir = F(((m[4] >> 4) & 0x0f) * 22.5)
    if (gust > 56 || avg > 56) return -4
    return msg('Oregon-WGR800', { ...h, wind_max_m_s: round3(gust), wind_avg_m_s: round3(avg), wind_dir_deg: round3(dir) }, m, len)
  }
  return -4
}

export const oregonScientific: IsmProtocol = {
  id: 'oregon_scientific',
  name: 'Oregon Scientific v2.1 and v3',
  modulation: 'ook_manchester',
  shortUs: 440,
  longUs: 0,
  resetUs: 2400,
  decode(bits, emit) {
    let r = v21(bits)
    if (typeof r === 'number' && r <= 0) r = v3(bits)
    if (typeof r === 'number') return r
    emit(r)
    return 1
  },
}

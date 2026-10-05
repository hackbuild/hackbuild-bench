/**
 * Tire pressure sensors: Schrader (FCC MRXGG4, 315 MHz in the US) and Toyota
 * (Pacific Industries PMV-C210).
 *
 * Ported from rtl_433 src/devices/schraeder.c and tpms_toyota.c
 * (GPL-2.0-or-later). Schrader is OOK manchester with a CRC-8 (poly 0x07,
 * init 0xf0). Toyota is FSK, differential manchester, with a CRC-8 (poly
 * 0x07, init 0x80) and the pressure sent twice, once inverted.
 */

import { BitBuffer } from '../bitbuffer'
import { crc8, f32mul, round3 } from '../checks'
import type { IsmProtocol } from '../types'

export const schrader: IsmProtocol = {
  id: 'schraeder',
  name: 'Schrader TPMS',
  modulation: 'ook_manchester',
  shortUs: 120,
  longUs: 0,
  resetUs: 480,
  decode(bits, emit) {
    if (bits.bits[0] !== 68) return -1
    const b = bits.extractBytes(0, 4, 64)
    if (b[7] !== crc8(b, 7, 0x07, 0xf0)) return -2
    const serial = (((b[1] & 0x0f) << 24) | (b[2] << 16) | (b[3] << 8) | b[4]) >>> 0
    const flags = ((b[0] & 0x0f) << 4) | (b[1] >> 4)
    emit({
      model: 'Schrader',
      fields: {
        type: 'TPMS',
        flags: flags.toString(16).padStart(2, '0'),
        id: serial.toString(16).toUpperCase().padStart(7, '0'),
        pressure_kPa: round3(f32mul(b[5] * 25, 0.1)),
        temperature_C: b[6] - 50,
        mic: 'CRC',
      },
      bytes: b,
    })
    return 1
  },
}

const TOYOTA_PREAMBLE = [0xa9, 0xe0]

export const toyota: IsmProtocol = {
  id: 'tpms_toyota',
  name: 'Toyota TPMS',
  modulation: 'fsk_pcm',
  shortUs: 52,
  longUs: 52,
  resetUs: 150,
  decode(bits, emit) {
    let pos = 0
    let events = 0
    const packet = new BitBuffer()
    while ((pos = bits.search(0, pos, TOYOTA_PREAMBLE, 12)) + 156 <= bits.bits[0]) {
      const start = pos + 11
      packet.clear()
      const end = bits.differentialManchesterDecode(0, start, packet, 80)
      pos += 2
      if (end - start < 144) continue
      const b = packet.rows[0]
      if (crc8(b, 8, 0x07, 0x80) !== b[8]) continue
      const id = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
      const status = (b[4] & 0x80) | (b[6] & 0x7f)
      const p1 = ((b[4] & 0x7f) << 1) | (b[5] >> 7)
      const temp = ((b[5] & 0x7f) << 1) | (b[6] >> 7)
      const p2 = b[7] ^ 0xff
      if (p1 !== p2) continue
      emit({
        model: 'Toyota',
        fields: {
          type: 'TPMS',
          id: id.toString(16).padStart(8, '0'),
          status,
          pressure_PSI: round3(p1 * 0.25 - 7),
          temperature_C: temp - 40,
          mic: 'CRC',
        },
        bytes: b.slice(0, 9),
      })
      events++
    }
    return events
  },
}

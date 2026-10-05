/**
 * Generic fixed code remotes and sensors on the PT2260, PT2262, SC2260,
 * SC2262 and EV1527 encoders: key fobs, door contacts, PIRs, doorbells.
 *
 * Ported from rtl_433 src/devices/generic_remote.c (GPL-2.0-or-later).
 * 24 data bits plus a stop bit, no checksum. The code is also shown as
 * PT2262 tri-state, where 10 is invalid for a PT2262 and valid for an EV1527.
 */

import type { IsmProtocol } from '../types'

const TRI = ['0', 'Z', 'X', '1']

export const genericRemote: IsmProtocol = {
  id: 'generic_remote',
  name: 'Generic remote, PT2262 and EV1527',
  modulation: 'ook_pwm',
  shortUs: 464,
  longUs: 1404,
  resetUs: 1800,
  toleranceUs: 200,
  decode(bits, emit) {
    const b = bits.rows[0]
    if (!b) return -1
    b[0] = ~b[0] & 0xff
    b[1] = ~b[1] & 0xff
    b[2] = ~b[2] & 0xff
    if (bits.bits[0] !== 25 || (b[3] & 0x80) === 0 || (b[0] === 0 && b[1] === 0) || b[2] === 0) return -1
    const full = (b[0] << 16) | (b[1] << 8) | b[2]
    let tristate = ''
    for (let i = 22; i >= 0; i -= 2) tristate += TRI[(full >> i) & 3]
    emit({
      model: 'Generic-Remote',
      fields: { id: (b[0] << 8) | b[1], cmd: b[2], tristate },
      bytes: b.slice(0, 3),
    })
    return 1
  },
}

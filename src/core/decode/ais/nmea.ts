/**
 * NMEA 0183 !AIVDM sentences, the form every AIS tool reads and writes.
 *
 * The payload is armoured six bits to a character: 0 to 39 become '0' to 'W'
 * and 40 to 63 become '`' to 'w'. A sentence carries at most 60 payload
 * characters, so a type 5 goes out in two, tied by a sequential id that
 * cycles 0 to 9.
 */

const MAX_CHARS = 60

export interface Armoured {
  payload: string
  /** Bits added to fill the last character, 0 to 5. */
  fill: number
}

export function armour(bytes: Uint8Array, bitLength = bytes.length * 8): Armoured {
  let payload = ''
  for (let at = 0; at < bitLength; at += 6) {
    let v = 0
    for (let i = 0; i < 6; i++) {
      const b = at + i
      const bit = b < bitLength ? (bytes[b >> 3] >> (7 - (b & 7))) & 1 : 0
      v = (v << 1) | bit
    }
    payload += String.fromCharCode(v < 40 ? v + 48 : v + 56)
  }
  return { payload, fill: (6 - (bitLength % 6)) % 6 }
}

/** Reverses armour. Returns null on a character outside the alphabet. */
export function unarmour(payload: string, fill: number): Uint8Array | null {
  const bits = payload.length * 6 - fill
  const out = new Uint8Array(Math.ceil(bits / 8))
  for (let c = 0; c < payload.length; c++) {
    let v = payload.charCodeAt(c) - 48
    if (v > 40) v -= 8
    if (v < 0 || v > 63) return null
    for (let i = 0; i < 6; i++) {
      const b = c * 6 + i
      if (b >= bits) break
      if ((v >> (5 - i)) & 1) out[b >> 3] |= 1 << (7 - (b & 7))
    }
  }
  return out
}

function checksum(body: string): string {
  let x = 0
  for (let i = 0; i < body.length; i++) x ^= body.charCodeAt(i)
  return x.toString(16).toUpperCase().padStart(2, '0')
}

/** Builds sentences for one message. `seq` matters only when it needs more than one. */
export function toNmea(bytes: Uint8Array, channel: string, seq: number): string[] {
  const { payload, fill } = armour(bytes)
  const parts = Math.max(1, Math.ceil(payload.length / MAX_CHARS))
  const out: string[] = []
  for (let p = 0; p < parts; p++) {
    const chunk = payload.slice(p * MAX_CHARS, (p + 1) * MAX_CHARS)
    const last = p === parts - 1
    const body = `AIVDM,${parts},${p + 1},${parts > 1 ? seq % 10 : ''},${channel},${chunk},${last ? fill : 0}`
    out.push(`!${body}*${checksum(body)}`)
  }
  return out
}

/**
 * AIS message payloads, ITU-R M.1371.
 *
 * Fields are packed most significant bit first with no alignment. Text is
 * six bit: values under 32 are '@' to '_', the rest are space to '?', and
 * '@' pads the end. Positions are in ten thousandths of a minute, with 181
 * degrees of longitude and 91 of latitude meaning not available.
 */

export class Bits {
  readonly bytes: Uint8Array
  readonly length: number

  constructor(bytes: Uint8Array, length = bytes.length * 8) {
    this.bytes = bytes
    this.length = length
  }

  /** Unsigned field. Bits past the end read as zero, as receivers treat a short message. */
  u(start: number, width: number): number {
    let v = 0
    for (let i = 0; i < width; i++) {
      const b = start + i
      const bit = b < this.length ? (this.bytes[b >> 3] >> (7 - (b & 7))) & 1 : 0
      v = v * 2 + bit
    }
    return v
  }

  /** Two's complement field. */
  s(start: number, width: number): number {
    const v = this.u(start, width)
    return v >= 2 ** (width - 1) ? v - 2 ** width : v
  }

  text(start: number, chars: number): string {
    let out = ''
    for (let i = 0; i < chars; i++) {
      if (start + i * 6 + 6 > this.length) break
      const v = this.u(start + i * 6, 6)
      out += String.fromCharCode(v < 32 ? v + 64 : v)
    }
    return out.replace(/@.*$/, '').trim()
  }
}

export const NAV_STATUS = [
  'under way using engine',
  'at anchor',
  'not under command',
  'restricted manoeuvrability',
  'constrained by draught',
  'moored',
  'aground',
  'engaged in fishing',
  'under way sailing',
  'reserved for hsc',
  'reserved for wig',
  'power-driven vessel towing astern',
  'power-driven vessel pushing ahead',
  'reserved',
  'ais-sart active',
  'not defined',
]

export function shipTypeName(code: number): string {
  if (code === 0) return ''
  if (code >= 20 && code <= 29) return 'wing in ground'
  const exact: Record<number, string> = {
    30: 'fishing',
    31: 'towing',
    32: 'towing, large',
    33: 'dredging',
    34: 'diving',
    35: 'military',
    36: 'sailing',
    37: 'pleasure craft',
    50: 'pilot',
    51: 'search and rescue',
    52: 'tug',
    53: 'port tender',
    54: 'anti-pollution',
    55: 'law enforcement',
    58: 'medical transport',
    59: 'noncombatant',
  }
  if (exact[code]) return exact[code]
  if (code >= 40 && code <= 49) return 'high speed craft'
  if (code >= 60 && code <= 69) return 'passenger'
  if (code >= 70 && code <= 79) return 'cargo'
  if (code >= 80 && code <= 89) return 'tanker'
  if (code >= 90 && code <= 99) return 'other'
  return `type ${code}`
}

export const AID_TYPES = [
  'unspecified',
  'reference point',
  'racon',
  'fixed structure',
  'spare',
  'light',
  'light, sectors',
  'leading light front',
  'leading light rear',
  'beacon, cardinal n',
  'beacon, cardinal e',
  'beacon, cardinal s',
  'beacon, cardinal w',
  'beacon, port hand',
  'beacon, starboard hand',
  'beacon, preferred port',
  'beacon, preferred starboard',
  'beacon, isolated danger',
  'beacon, safe water',
  'beacon, special mark',
  'cardinal mark n',
  'cardinal mark e',
  'cardinal mark s',
  'cardinal mark w',
  'port hand mark',
  'starboard hand mark',
  'preferred channel port',
  'preferred channel starboard',
  'isolated danger',
  'safe water',
  'special mark',
  'light vessel or lanby or rig',
]

export interface AisMessage {
  type: number
  repeat: number
  mmsi: number
  /** Degrees, north and east positive. */
  lat?: number
  lon?: number
  /** Knots. */
  sog?: number
  /** Degrees true. */
  cog?: number
  heading?: number
  /** Rate of turn in degrees a minute, signed, when the sender gives one. */
  rot?: number
  status?: string
  accuracy?: boolean
  name?: string
  callsign?: string
  imo?: number
  shipType?: number
  destination?: string
  /** Metres. */
  draught?: number
  /** Metres: to bow, to stern, to port, to starboard. */
  dims?: [number, number, number, number]
  /** Month, day, hour, minute as sent, zero where not available. */
  eta?: [number, number, number, number]
  /** Base station time, iso 8601 utc. */
  utc?: string
  aidType?: string
  virtual?: boolean
  offPosition?: boolean
  /** Type 24 part, 0 for A and 1 for B. */
  part?: number
  vendor?: string
  /** Class B units: the cs flag, true when it is a carrier sense unit. */
  classBCs?: boolean
  /** Second of the minute the position was taken, 60 and up meaning not available. */
  second?: number
}

function lonOf(raw: number): number | undefined {
  const deg = raw / 600000
  return Math.abs(deg) > 180 ? undefined : deg
}

function latOf(raw: number): number | undefined {
  const deg = raw / 600000
  return Math.abs(deg) > 90 ? undefined : deg
}

function sogOf(raw: number): number | undefined {
  return raw === 1023 ? undefined : raw / 10
}

function cogOf(raw: number): number | undefined {
  return raw >= 3600 ? undefined : raw / 10
}

function headingOf(raw: number): number | undefined {
  return raw === 511 || raw > 359 ? undefined : raw
}

function dimsOf(b: Bits, at: number): [number, number, number, number] {
  return [b.u(at, 9), b.u(at + 9, 9), b.u(at + 18, 6), b.u(at + 24, 6)]
}

function rotOf(raw: number): number | undefined {
  if (raw === -128) return undefined
  if (raw === 0) return 0
  const v = (raw / 4.733) ** 2
  return raw < 0 ? -v : v
}

/** Decodes a message, or returns null for a type it does not know or a short one. */
export function parseAis(bytes: Uint8Array, bitLength = bytes.length * 8): AisMessage | null {
  const b = new Bits(bytes, bitLength)
  if (bitLength < 38) return null
  const type = b.u(0, 6)
  const m: AisMessage = { type, repeat: b.u(6, 2), mmsi: b.u(8, 30) }

  switch (type) {
    case 1:
    case 2:
    case 3:
      if (bitLength < 149) return m
      m.status = NAV_STATUS[b.u(38, 4)]
      m.rot = rotOf(b.s(42, 8))
      m.sog = sogOf(b.u(50, 10))
      m.accuracy = b.u(60, 1) === 1
      m.lon = lonOf(b.s(61, 28))
      m.lat = latOf(b.s(89, 27))
      m.cog = cogOf(b.u(116, 12))
      m.heading = headingOf(b.u(128, 9))
      m.second = b.u(137, 6)
      return m
    case 4:
    case 11: {
      if (bitLength < 134) return m
      const y = b.u(38, 14)
      const mo = b.u(52, 4)
      const d = b.u(56, 5)
      const h = b.u(61, 5)
      const mi = b.u(66, 6)
      const s = b.u(72, 6)
      if (y && mo && d && h < 24 && mi < 60 && s < 60) {
        const p = (v: number, w = 2) => String(v).padStart(w, '0')
        m.utc = `${p(y, 4)}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}Z`
      }
      m.accuracy = b.u(78, 1) === 1
      m.lon = lonOf(b.s(79, 28))
      m.lat = latOf(b.s(107, 27))
      return m
    }
    case 5:
      if (bitLength < 420) return m
      m.imo = b.u(40, 30) || undefined
      m.callsign = b.text(70, 7)
      m.name = b.text(112, 20)
      m.shipType = b.u(232, 8)
      m.dims = dimsOf(b, 240)
      m.eta = [b.u(274, 4), b.u(278, 5), b.u(283, 5), b.u(288, 6)]
      m.draught = b.u(294, 8) / 10
      m.destination = b.text(302, 20)
      return m
    case 18:
      if (bitLength < 148) return m
      m.sog = sogOf(b.u(46, 10))
      m.accuracy = b.u(56, 1) === 1
      m.lon = lonOf(b.s(57, 28))
      m.lat = latOf(b.s(85, 27))
      m.cog = cogOf(b.u(112, 12))
      m.heading = headingOf(b.u(124, 9))
      m.second = b.u(133, 6)
      m.classBCs = b.u(141, 1) === 1
      return m
    case 19:
      if (bitLength < 312) return m
      m.sog = sogOf(b.u(46, 10))
      m.accuracy = b.u(56, 1) === 1
      m.lon = lonOf(b.s(57, 28))
      m.lat = latOf(b.s(85, 27))
      m.cog = cogOf(b.u(112, 12))
      m.heading = headingOf(b.u(124, 9))
      m.second = b.u(133, 6)
      m.name = b.text(143, 20)
      m.shipType = b.u(263, 8)
      m.dims = dimsOf(b, 271)
      return m
    case 21: {
      if (bitLength < 272) return m
      m.aidType = AID_TYPES[b.u(38, 5)]
      const ext = Math.floor(Math.max(0, bitLength - 272) / 6)
      m.name = (b.text(43, 20) + (ext ? b.text(272, Math.min(14, ext)) : '')).trim()
      m.accuracy = b.u(163, 1) === 1
      m.lon = lonOf(b.s(164, 28))
      m.lat = latOf(b.s(192, 27))
      m.dims = dimsOf(b, 219)
      m.second = b.u(253, 6)
      m.offPosition = b.u(259, 1) === 1
      m.virtual = b.u(269, 1) === 1
      return m
    }
    case 24: {
      if (bitLength < 160) return m
      m.part = b.u(38, 2)
      if (m.part === 0) {
        m.name = b.text(40, 20)
        return m
      }
      if (bitLength < 162) return m
      m.shipType = b.u(40, 8)
      m.vendor = b.text(48, 3)
      m.callsign = b.text(90, 7)
      // an auxiliary craft carries its mother ship's mmsi where the size goes.
      if (Math.floor(m.mmsi / 10000000) !== 98) m.dims = dimsOf(b, 132)
      return m
    }
    default:
      return m
  }
}

/** One line of what a message says, for logs and the console. */
export function describeAis(m: AisMessage): string {
  const bits: string[] = [`type ${m.type}`]
  if (m.name) bits.push(m.name.toLowerCase())
  if (m.callsign) bits.push(m.callsign.toLowerCase())
  if (m.lat !== undefined && m.lon !== undefined) bits.push(`${m.lat.toFixed(4)}, ${m.lon.toFixed(4)}`)
  if (m.sog !== undefined) bits.push(`${m.sog.toFixed(1)} kn`)
  if (m.cog !== undefined) bits.push(`cog ${m.cog.toFixed(0)}`)
  if (m.destination) bits.push(`to ${m.destination.toLowerCase()}`)
  if (m.utc) bits.push(m.utc)
  if (m.aidType) bits.push(m.aidType)
  return bits.join('  ')
}

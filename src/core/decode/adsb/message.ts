import { flipBit, modesChecksum, singleBitError } from './crc'

/**
 * Mode S frame scoring, correction and field decoding.
 *
 * The scoring ranks follow dump1090-fa's mode_s.c, so a frame this accepts or
 * rejects is one dump1090-fa would treat the same way given the same bits.
 * Bit numbers in comments are 1-based across the whole frame, as in the
 * ICAO Annex 10 tables.
 */

/** Which addresses have been heard on a checked frame recently. */
export interface IcaoFilter {
  has(key: number): boolean
}

/** Keeps DF18 addresses apart from DF17 ones, since they are a separate space. */
export const NON_TRANSPONDER = 0x1000000

/** Ordered from worst to best. A frame below ACCEPT is dropped. */
export const Score = {
  NotSet: 0,
  AllZeros: 1,
  UnknownDf: 2,
  Uncorrectable: 3,
  UnknownThreshold: 4,
  UnreliableUnknown: 5,
  Df11Iid1ErrorUnknown: 6,
  Df11Acq1ErrorUnknown: 7,
  Df11IidUnknown: 8,
  Accept: 9,
  UnreliableKnown: 10,
  Df181ErrorUnknown: 11,
  Df171ErrorUnknown: 12,
  Df11AcqUnknown: 13,
  Df11Iid1ErrorKnown: 14,
  Df11Acq1ErrorKnown: 15,
  Df11IidKnown: 16,
  Df181ErrorKnown: 17,
  Df171ErrorKnown: 18,
  Df11AcqKnown: 19,
  Df18Unknown: 20,
  Df17Unknown: 21,
  Df18Known: 22,
  Df17Known: 23,
} as const

export type Score = number

export function messageBits(df: number): 56 | 112 {
  return df & 16 ? 112 : 56
}

/** Bits first to last inclusive, 1-based, at most 32 wide. */
export function getBits(msg: Uint8Array, first: number, last: number): number {
  let v = 0
  for (let b = first - 1; b < last; b++) v = v * 2 + ((msg[b >> 3] >> (7 - (b & 7))) & 1)
  return v
}

// DF values whose first byte could become a DF11, DF17 or DF18 after one
// flipped bit, as bitsets. Saves a CRC on frames that could never qualify.
const CORRECTABLE_SHORT = 0x08008e08
const CORRECTABLE_LONG = 0x066f0006

interface Corrected {
  out: Uint8Array
  /** Bits flipped, or -1 when no fix produced a checked frame. */
  fixed: number
  shortSyndrome: number
  longSyndrome: number
}

const UNCHECKED = -1

function isLongPI(msg: Uint8Array): boolean {
  const df = msg[0] >> 3
  return df === 17 || df === 18
}

function isShortPI(msg: Uint8Array): boolean {
  return msg[0] >> 3 === 11
}

/**
 * Tries the frame as it came, then with one bit flipped, as a DF11, DF17 or
 * DF18. The DF bits themselves may be the ones repaired.
 */
function correct(input: Uint8Array): Corrected {
  const df = input[0] >> 3
  const dfBit = 1 << df
  let shortSyndrome = UNCHECKED
  let longSyndrome = UNCHECKED
  let longBit = -1
  let shortBit = -1

  if ((CORRECTABLE_LONG & dfBit) !== 0) {
    longSyndrome = modesChecksum(input, 112)
    if (isLongPI(input) && longSyndrome === 0) {
      return { out: input.slice(), fixed: 0, shortSyndrome, longSyndrome }
    }
    longBit = singleBitError(longSyndrome, 112)
  }
  if ((CORRECTABLE_SHORT & dfBit) !== 0) {
    shortSyndrome = modesChecksum(input, 56)
    if (isShortPI(input) && (shortSyndrome & 0xffff80) === 0) {
      return { out: input.slice(), fixed: 0, shortSyndrome, longSyndrome }
    }
    // assumes an interrogator id of zero, as dump1090 does.
    shortBit = singleBitError(shortSyndrome, 56)
  }

  if (longBit >= 0) {
    const out = input.slice()
    flipBit(out, longBit)
    if (isLongPI(out)) return { out, fixed: 1, shortSyndrome, longSyndrome }
  }
  if (shortBit >= 0) {
    const out = input.slice()
    flipBit(out, shortBit)
    if (isShortPI(out)) return { out, fixed: 1, shortSyndrome, longSyndrome }
  }
  return { out: input.slice(), fixed: -1, shortSyndrome, longSyndrome }
}

function allZeroShort(msg: Uint8Array): boolean {
  for (let i = 0; i < 7; i++) if (msg[i]) return false
  return true
}

/** How plausible a raw frame is. Anything at or above Score.Accept is taken. */
export function scoreFrame(raw: Uint8Array, icao: IcaoFilter): Score {
  if (allZeroShort(raw)) return Score.AllZeros
  const c = correct(raw)
  const msg = c.out
  const df = msg[0] >> 3
  switch (df) {
    case 0:
    case 4:
    case 5: {
      const s = c.shortSyndrome === UNCHECKED ? modesChecksum(msg, 56) : c.shortSyndrome
      return icao.has(s) ? Score.UnreliableKnown : Score.UnreliableUnknown
    }
    case 16:
    case 20:
    case 21: {
      const s = c.longSyndrome === UNCHECKED ? modesChecksum(msg, 112) : c.longSyndrome
      return icao.has(s) ? Score.UnreliableKnown : Score.UnreliableUnknown
    }
    case 11: {
      const addr = getBits(msg, 9, 32)
      const s = c.shortSyndrome === UNCHECKED ? modesChecksum(msg, 56) : c.shortSyndrome
      const iid = s & 0x7f
      const known = icao.has(addr)
      if (c.fixed === 0) {
        if (iid === 0) return known ? Score.Df11AcqKnown : Score.Df11AcqUnknown
        return known ? Score.Df11IidKnown : Score.Df11IidUnknown
      }
      if (c.fixed === 1) {
        if (iid === 0) return known ? Score.Df11Acq1ErrorKnown : Score.Df11Acq1ErrorUnknown
        return known ? Score.Df11Iid1ErrorKnown : Score.Df11Iid1ErrorUnknown
      }
      return Score.Uncorrectable
    }
    case 17: {
      const known = icao.has(getBits(msg, 9, 32))
      if (c.fixed === 0) return known ? Score.Df17Known : Score.Df17Unknown
      if (c.fixed === 1) return known ? Score.Df171ErrorKnown : Score.Df171ErrorUnknown
      return Score.Uncorrectable
    }
    case 18: {
      const known = icao.has(getBits(msg, 9, 32) | NON_TRANSPONDER)
      if (c.fixed === 0) return known ? Score.Df18Known : Score.Df18Unknown
      if (c.fixed === 1) return known ? Score.Df181ErrorKnown : Score.Df181ErrorUnknown
      return Score.Uncorrectable
    }
    default:
      return Score.UnknownDf
  }
}

/** A raw CPR position as sent, before it is resolved against anything. */
export interface CprReport {
  odd: boolean
  /** 17 bit fractions of a zone. */
  lat: number
  lon: number
  surface: boolean
}

export interface ModeSMessage {
  df: number
  /** The frame after correction, 7 or 14 bytes. */
  bytes: Uint8Array
  hex: string
  /** 24 bit address, from the AA field or recovered from the parity. */
  icao: number
  /** Bits repaired by the parity check. */
  corrected: number
  /** Address read from a checked field rather than inferred from the parity. */
  reliable: boolean
  score: Score
  /** Extended squitter type code, for DF17 and DF18. */
  tc?: number
  altitudeFt?: number
  /** Altitude from the gnss rather than the barometer. */
  altitudeGnss?: boolean
  squawk?: string
  callsign?: string
  /** Emitter category, such as A3, when an identification message gave one. */
  category?: string
  onGround?: boolean
  cpr?: CprReport
  groundSpeedKt?: number
  trackDeg?: number
  airspeedKt?: number
  airspeedKind?: 'ias' | 'tas'
  headingDeg?: number
  verticalRateFpm?: number
}

const AIS_CHARSET = '?ABCDEFGHIJKLMNOPQRSTUVWXYZ????? ???????????????0123456789??????'

/** Eight 6 bit characters starting at bit `first`. Null when any is not printable. */
function decodeCallsign(msg: Uint8Array, first: number): string | null {
  let s = ''
  for (let i = 0; i < 8; i++) {
    const ch = AIS_CHARSET[getBits(msg, first + i * 6, first + i * 6 + 5)]
    if (ch === '?') return null
    s += ch
  }
  return s.trim()
}

/** Reorders the 13 bit identity or altitude field into 0xABCD nibble form. */
function id13ToGillham(f: number): number {
  let h = 0
  if (f & 0x1000) h |= 0x0010 // C1
  if (f & 0x0800) h |= 0x1000 // A1
  if (f & 0x0400) h |= 0x0020 // C2
  if (f & 0x0200) h |= 0x2000 // A2
  if (f & 0x0100) h |= 0x0040 // C4
  if (f & 0x0080) h |= 0x4000 // A4
  if (f & 0x0020) h |= 0x0100 // B1
  if (f & 0x0010) h |= 0x0001 // D1
  if (f & 0x0008) h |= 0x0200 // B2
  if (f & 0x0004) h |= 0x0002 // D2
  if (f & 0x0002) h |= 0x0400 // B4
  if (f & 0x0001) h |= 0x0004 // D4
  return h
}

/** Gillham mode C to hundreds of feet, or null for a code no encoder sends. */
function modeAToModeC(a: number): number | null {
  if ((a & 0xffff8889) !== 0 || (a & 0x00f0) === 0) return null
  let hundreds = 0
  if (a & 0x0010) hundreds ^= 7
  if (a & 0x0020) hundreds ^= 3
  if (a & 0x0040) hundreds ^= 1
  if ((hundreds & 5) === 5) hundreds ^= 2
  if (hundreds > 5) return null
  let fives = 0
  if (a & 0x0002) fives ^= 0x0ff
  if (a & 0x0004) fives ^= 0x07f
  if (a & 0x1000) fives ^= 0x03f
  if (a & 0x2000) fives ^= 0x01f
  if (a & 0x4000) fives ^= 0x00f
  if (a & 0x0100) fives ^= 0x007
  if (a & 0x0200) fives ^= 0x003
  if (a & 0x0400) fives ^= 0x001
  if (fives & 1) hundreds = 6 - hundreds
  return fives * 5 + hundreds - 13
}

function gillhamFeet(id13: number): number | undefined {
  const n = modeAToModeC(id13ToGillham(id13))
  if (n === null || n < -12) return undefined
  return n * 100
}

/** The 13 bit AC field of DF0, 4, 16 and 20. Metric altitudes are left undecoded. */
export function decodeAc13(ac: number): number | undefined {
  if (!ac) return undefined
  if (ac & 0x0040) return undefined
  if (ac & 0x0010) {
    const n = ((ac & 0x1f80) >> 2) | ((ac & 0x0020) >> 1) | (ac & 0x000f)
    return n * 25 - 1000
  }
  return gillhamFeet(ac)
}

/** The 12 bit altitude of an airborne position squitter. */
export function decodeAc12(ac: number): number | undefined {
  if (!ac) return undefined
  if (ac & 0x10) {
    const n = ((ac & 0x0fe0) >> 1) | (ac & 0x000f)
    return n * 25 - 1000
  }
  return gillhamFeet(((ac & 0x0fc0) << 1) | (ac & 0x003f))
}

export function decodeSquawk(id13: number): string {
  return id13ToGillham(id13).toString(16).padStart(4, '0')
}

function toHex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

/** Decodes the 56 bit ME field of an extended squitter, which starts at bit 33. */
function decodeExtended(m: ModeSMessage, msg: Uint8Array): void {
  const tc = getBits(msg, 33, 37)
  m.tc = tc
  const me = (a: number, b: number) => getBits(msg, 32 + a, 32 + b)
  const bit = (a: number) => getBits(msg, 32 + a, 32 + a)

  if (tc >= 1 && tc <= 4) {
    const sub = me(6, 8)
    if (sub) m.category = `${String.fromCharCode(0x45 - tc)}${sub}`
    const cs = decodeCallsign(msg, 41)
    if (cs !== null) m.callsign = cs
    return
  }

  if (tc >= 5 && tc <= 8) {
    m.onGround = true
    const movement = me(6, 12)
    if (movement > 0 && movement < 125) m.groundSpeedKt = groundMovement(movement)
    if (bit(13)) m.trackDeg = (me(14, 20) * 360) / 128
    m.cpr = { odd: bit(22) === 1, lat: me(23, 39), lon: me(40, 56), surface: true }
    return
  }

  if ((tc >= 9 && tc <= 18) || (tc >= 20 && tc <= 22)) {
    const ac = me(9, 20)
    if (tc <= 18) {
      const alt = decodeAc12(ac)
      if (alt !== undefined) m.altitudeFt = alt
    } else if (ac) {
      m.altitudeFt = Math.round(ac * 3.28084)
      m.altitudeGnss = true
    }
    m.onGround = false
    const lat = me(23, 39)
    const lon = me(40, 56)
    // an all zero position on a type 0 report means none, dump1090 drops them too.
    if (lat || lon || ac) m.cpr = { odd: bit(22) === 1, lat, lon, surface: false }
    return
  }

  if (tc === 19) {
    const sub = me(6, 8)
    if (sub < 1 || sub > 4) return
    const scale = sub === 2 || sub === 4 ? 4 : 1
    if (sub <= 2) {
      const ewRaw = me(15, 24)
      const nsRaw = me(26, 35)
      if (ewRaw && nsRaw) {
        const ew = (ewRaw - 1) * (bit(14) ? -1 : 1) * scale
        const ns = (nsRaw - 1) * (bit(25) ? -1 : 1) * scale
        m.groundSpeedKt = Math.round(Math.sqrt(ew * ew + ns * ns + 0.5))
        if (m.groundSpeedKt > 0) {
          let trk = (Math.atan2(ew, ns) * 180) / Math.PI
          if (trk < 0) trk += 360
          m.trackDeg = trk
        }
      }
    } else {
      if (bit(14)) m.headingDeg = (me(15, 24) * 360) / 1024
      const as = me(26, 35)
      if (as) {
        m.airspeedKt = (as - 1) * scale
        m.airspeedKind = bit(25) ? 'tas' : 'ias'
      }
    }
    const vr = me(38, 46)
    if (vr) m.verticalRateFpm = (vr - 1) * (bit(37) ? -64 : 64)
    return
  }

  if (tc === 28 && me(6, 8) === 1) {
    const id = me(12, 24)
    if (id) m.squawk = decodeSquawk(id)
  }
}

/** Ground speed from the surface movement code, the middle of each band. */
function groundMovement(mv: number): number {
  if (mv === 124) return 180
  if (mv >= 109) return 100 + (mv - 109 + 0.5) * 5
  if (mv >= 94) return 70 + (mv - 94 + 0.5) * 2
  if (mv >= 39) return 15 + (mv - 39 + 0.5)
  if (mv >= 13) return 2 + (mv - 13 + 0.5) * 0.5
  if (mv >= 9) return 1 + (mv - 9 + 0.5) * 0.25
  if (mv >= 2) return 0.125 + (mv - 2 + 0.5) * 0.125
  return 0
}

/**
 * Decodes a frame that scored at or above Score.Accept. Returns null for one
 * that does not, so the caller can hand it every candidate.
 */
export function decodeFrame(raw: Uint8Array, score: Score): ModeSMessage | null {
  if (score < Score.Accept) return null
  const c = correct(raw)
  const df = c.out[0] >> 3
  const bits = messageBits(df)
  const msg = c.out.subarray(0, bits >> 3)
  const syndrome = bits === 112
    ? (c.longSyndrome === UNCHECKED ? modesChecksum(msg, 112) : c.longSyndrome)
    : (c.shortSyndrome === UNCHECKED ? modesChecksum(msg, 56) : c.shortSyndrome)

  const m: ModeSMessage = {
    df,
    bytes: msg,
    hex: toHex(msg),
    icao: syndrome,
    corrected: c.fixed > 0 ? c.fixed : 0,
    reliable: false,
    score,
  }

  if (df === 11 || df === 17 || df === 18) {
    m.icao = getBits(msg, 9, 32)
    m.reliable = c.fixed === 0 && (df !== 11 || (syndrome & 0x7f) === 0)
  }

  if (df === 0 || df === 4 || df === 16 || df === 20) {
    const alt = decodeAc13(getBits(msg, 20, 32))
    if (alt !== undefined) m.altitudeFt = alt
  }
  if (df === 5 || df === 21) {
    const id = getBits(msg, 20, 32)
    m.squawk = decodeSquawk(id)
  }
  if (df === 4 || df === 5 || df === 20 || df === 21) {
    const fs = getBits(msg, 6, 8)
    if (fs === 1 || fs === 3) m.onGround = true
    else if (fs === 0 || fs === 2) m.onGround = false
  }
  if (df === 11 || df === 17) {
    const ca = getBits(msg, 6, 8)
    if (ca === 4) m.onGround = true
    else if (ca === 5) m.onGround = false
  }
  if (df === 0 || df === 16) {
    if (getBits(msg, 6, 6)) m.onGround = true
  }

  if (df === 17) decodeExtended(m, msg)
  if (df === 18) {
    const cf = getBits(msg, 6, 8)
    // 0 and 1 are ads-b from a non-transponder device, 2, 5 and 6 are tis-b
    // and ads-r rebroadcasts with the same message layout.
    if (cf === 0 || cf === 1 || cf === 2 || cf === 5 || cf === 6) decodeExtended(m, msg)
  }

  // comm-b identification (bds 2,0). Cheap to recognise, and the only comm-b
  // register read here, since the others need heuristics to tell apart.
  if ((df === 20 || df === 21) && msg[4] === 0x20) {
    const cs = decodeCallsign(msg, 41)
    if (cs) m.callsign = cs
  }

  return m
}

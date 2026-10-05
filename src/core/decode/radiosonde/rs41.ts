/**
 * Vaisala RS41 radiosonde frames.
 *
 * The sonde sends gfsk at 4800 baud somewhere in 400 to 406 MHz, one frame a
 * second. A frame is 320 bytes, or 518 when it carries extra sensor data,
 * sent least significant bit first and whitened by xor with a 64 byte mask.
 * After an 8 byte header come 48 bytes of Reed-Solomon parity covering two
 * interleaved RS(255, 231) codewords: even bytes from 56 on in one, odd in
 * the other, padded with zeros to 518. Then a frame type byte and a chain of
 * blocks, each an id, a length, the data and a crc-16.
 *
 * The blocks read here:
 *
 * - 0x79 status: frame number, the eight character serial, battery, and one
 *   16 byte fragment of the 51 fragment calibration table.
 * - 0x7a measurements: 24 bit counts from the sensor oscillators.
 * - 0x7c gps time: week and time of week.
 * - 0x7b gps position: ecef x, y, z in cm and velocity in cm/s.
 *
 * Temperature comes out of the main sensor counts once the fragments holding
 * its reference resistors and polynomial have arrived. Humidity needs a 42
 * term matrix and a pressure correction, and is left uncalibrated here.
 */

import { RS_K, RS_N, RS_PARITY, rsDecode } from './reedsolomon'

export const RS41_BAUD = 4800
export const RS41_STD_LEN = 320
export const RS41_EXT_LEN = 518
const PARITY_POS = 8
const MSG_POS = 56
const BLOCKS_POS = 57

/** The header as it goes on air, before descrambling, least significant bit first per byte. */
export const RS41_HEADER_AIR = [0x10, 0xb6, 0xca, 0x11, 0x22, 0x96, 0x12, 0xf8]

export const RS41_MASK = new Uint8Array([
  0x96, 0x83, 0x3e, 0x51, 0xb1, 0x49, 0x08, 0x98, 0x32, 0x05, 0x59, 0x0e, 0xf9, 0x44, 0xc6, 0x26,
  0x21, 0x60, 0xc2, 0xea, 0x79, 0x5d, 0x6d, 0xa1, 0x54, 0x69, 0x47, 0x0c, 0xdc, 0xe8, 0x5c, 0xf1,
  0xf7, 0x76, 0x82, 0x7f, 0x07, 0x99, 0xa2, 0x2c, 0x93, 0x7c, 0x30, 0x63, 0xf5, 0x10, 0x2e, 0x61,
  0xd0, 0xbc, 0xb4, 0xb6, 0x06, 0xaa, 0xf4, 0x23, 0x78, 0x6e, 0x3b, 0xae, 0xbf, 0x7b, 0x4c, 0xc1,
])

const GPS_EPOCH_MS = Date.UTC(1980, 0, 6)

/** Seconds gps time runs ahead of utc, by when. No leap second has been added since 2017. */
const LEAPS: Array<[number, number]> = [
  [Date.UTC(2017, 0, 1), 18],
  [Date.UTC(2015, 6, 1), 17],
  [Date.UTC(2012, 6, 1), 16],
  [Date.UTC(2009, 0, 1), 15],
]

export function gpsToUtc(week: number, towMs: number): Date {
  const gps = GPS_EPOCH_MS + week * 604_800_000 + towMs
  const leap = LEAPS.find(([from, s]) => gps - s * 1000 >= from)?.[1] ?? 14
  return new Date(gps - leap * 1000)
}

export interface Rs41Frame {
  frame: number
  serial: string
  /** Volts. */
  battery?: number
  /** Utc, iso 8601, from the gps week and time of week. */
  time?: string
  lat?: number
  lon?: number
  /** Metres above the wgs84 ellipsoid. */
  alt?: number
  /** Metres a second over the ground. */
  speed?: number
  /** Degrees true the sonde is moving toward. */
  heading?: number
  /** Metres a second, positive up. */
  climb?: number
  sats?: number
  /** Celsius, set once the calibration fragments for it have arrived. */
  temperature?: number
  /** Raw humidity oscillator counts: sensor, reference one, reference two. */
  humidityCounts?: [number, number, number]
  /** Calibration fragments received for this serial, out of 51. */
  calibration: number
  /** Bytes each codeword needed corrected. */
  corrected: [number, number]
  /** Blocks whose crc failed. */
  badBlocks: number
  extended: boolean
  /** The descrambled, corrected frame. */
  bytes: Uint8Array
}

// ---------------------------------------------------------------------------
// frame layer
// ---------------------------------------------------------------------------

export function crc16(b: Uint8Array, from: number, len: number): number {
  let crc = 0xffff
  for (let i = from; i < from + len; i++) {
    crc ^= b[i] << 8
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

function correct(frame: Uint8Array, len: number): [number, number] | null {
  const work = frame.slice()
  for (let i = len; i < RS41_EXT_LEN; i++) work[i] = 0
  const out: [number, number] = [0, 0]
  for (let c = 0; c < 2; c++) {
    const cw = new Uint8Array(RS_N)
    for (let i = 0; i < RS_PARITY; i++) cw[i] = work[PARITY_POS + c * RS_PARITY + i]
    for (let i = 0; i < RS_K; i++) cw[RS_PARITY + i] = work[MSG_POS + 2 * i + c]
    const n = rsDecode(cw)
    if (n < 0) return null
    out[c] = n
    for (let i = 0; i < RS_PARITY; i++) work[PARITY_POS + c * RS_PARITY + i] = cw[i]
    for (let i = 0; i < RS_K; i++) {
      const at = MSG_POS + 2 * i + c
      if (at < len) work[at] = cw[RS_PARITY + i]
    }
  }
  frame.set(work.subarray(0, len))
  return out
}

const i32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24))
const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8)
const s16 = (b: Uint8Array, at: number) => (u16(b, at) << 16) >> 16
const u24 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)
const u32 = (b: Uint8Array, at: number) => i32(b, at) >>> 0

/** Wgs84 ecef to latitude, longitude and height, by Bowring's method. */
export function ecefToGeo(x: number, y: number, z: number): { lat: number; lon: number; alt: number } {
  const a = 6378137
  const f = 1 / 298.257223563
  const b = a * (1 - f)
  const e2 = f * (2 - f)
  const ep2 = (a * a - b * b) / (b * b)
  const p = Math.hypot(x, y)
  const th = Math.atan2(z * a, p * b)
  const lon = Math.atan2(y, x)
  const lat = Math.atan2(z + ep2 * b * Math.sin(th) ** 3, p - e2 * a * Math.cos(th) ** 3)
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2)
  const alt = p / Math.cos(lat) - n
  return { lat: (lat * 180) / Math.PI, lon: (lon * 180) / Math.PI, alt }
}

/** Keeps the calibration table of each sonde heard, since it arrives a fragment a second. */
export class Rs41Calibration {
  private readonly tables = new Map<string, { bytes: Uint8Array; have: Set<number> }>()

  add(serial: string, index: number, frag: Uint8Array): void {
    if (index > 50) return
    let t = this.tables.get(serial)
    if (!t) {
      t = { bytes: new Uint8Array(51 * 16), have: new Set() }
      this.tables.set(serial, t)
    }
    t.bytes.set(frag, index * 16)
    t.have.add(index)
  }

  count(serial: string): number {
    return this.tables.get(serial)?.have.size ?? 0
  }

  /** Celsius from the main sensor counts, or undefined until fragments 3 to 6 are in. */
  temperature(serial: string, f: number, f1: number, f2: number): number | undefined {
    const t = this.tables.get(serial)
    if (!t || ![3, 4, 5, 6].every((i) => t.have.has(i)) || f2 === f1) return undefined
    const v = new DataView(t.bytes.buffer)
    const fl = (at: number) => v.getFloat32(at, true)
    const rf1 = fl(61)
    const rf2 = fl(65)
    const co = [fl(77), fl(81), fl(85)]
    const cal = [fl(89), fl(93), fl(97)]
    // two reference resistors give the gain and offset of the oscillator.
    const g = (f2 - f1) / (rf2 - rf1)
    const rb = (f1 * rf2 - f2 * rf1) / (f2 - f1)
    const r = (f / g - rb) * cal[0]
    const temp = (co[0] + co[1] * r + co[2] * r * r + cal[1]) * (1 + cal[2])
    return Number.isFinite(temp) && temp > -120 && temp < 80 ? temp : undefined
  }
}

/**
 * Descrambles, corrects and reads one frame. `air` holds 518 bytes as they
 * came off the air, header included. Returns null when the frame cannot be
 * corrected and no block in it checks.
 */
export function parseRs41(air: Uint8Array, cal: Rs41Calibration): Rs41Frame | null {
  const frame = new Uint8Array(RS41_EXT_LEN)
  for (let i = 0; i < RS41_EXT_LEN; i++) frame[i] = (air[i] ?? 0) ^ RS41_MASK[i % 64]

  // a standard frame is zero padded for the code, an extended one fills it.
  let len = RS41_STD_LEN
  let fixed = correct(frame, RS41_STD_LEN)
  if (!fixed || frame[MSG_POS] !== 0x0f) {
    const again = new Uint8Array(RS41_EXT_LEN)
    for (let i = 0; i < RS41_EXT_LEN; i++) again[i] = (air[i] ?? 0) ^ RS41_MASK[i % 64]
    const ext = correct(again, RS41_EXT_LEN)
    if (ext && again[MSG_POS] === 0xf0) {
      frame.set(again)
      fixed = ext
      len = RS41_EXT_LEN
    }
  }

  const out: Rs41Frame = {
    frame: -1,
    serial: '',
    calibration: 0,
    corrected: fixed ?? [-1, -1],
    badBlocks: 0,
    extended: len === RS41_EXT_LEN,
    bytes: frame.slice(0, len),
  }
  let good = 0
  let pos = BLOCKS_POS
  let ecef: Int32Array | null = null
  let vel: Int16Array | null = null
  let meas: number[] | null = null
  let fragIndex = -1
  let frag: Uint8Array | null = null
  while (pos + 4 <= len) {
    const id = frame[pos]
    const n = frame[pos + 1]
    if (pos + 4 + n > len) break
    const d = pos + 2
    if (crc16(frame, d, n) !== u16(frame, d + n)) {
      out.badBlocks++
      pos += 4 + n
      continue
    }
    good++
    switch (id) {
      case 0x79:
        if (n >= 40) {
          out.frame = u16(frame, d)
          let s = ''
          for (let i = 0; i < 8; i++) s += String.fromCharCode(frame[d + 2 + i])
          out.serial = /^[\x20-\x7e]{8}$/.test(s) ? s.trim() : ''
          out.battery = frame[d + 10] / 10
          fragIndex = frame[d + 23]
          frag = frame.slice(d + 24, d + 40)
        }
        break
      case 0x7a:
        if (n >= 36) {
          meas = []
          for (let i = 0; i < 12; i++) meas.push(u24(frame, d + 3 * i))
        }
        break
      case 0x7c:
        if (n >= 6) {
          const week = u16(frame, d)
          const tow = u32(frame, d + 2)
          if (week > 1000 && tow < 604_800_000) {
            out.time = gpsToUtc(week, tow).toISOString()
          }
        }
        break
      case 0x7b:
        if (n >= 21) {
          ecef = new Int32Array([i32(frame, d), i32(frame, d + 4), i32(frame, d + 8)])
          vel = new Int16Array([s16(frame, d + 12), s16(frame, d + 14), s16(frame, d + 16)])
          out.sats = frame[d + 18]
        }
        break
      default:
        break
    }
    pos += 4 + n
  }
  if (!fixed && good === 0) return null

  if (out.serial && frag && fragIndex >= 0) cal.add(out.serial, fragIndex, frag)
  out.calibration = out.serial ? cal.count(out.serial) : 0

  if (ecef && vel && (ecef[0] || ecef[1] || ecef[2])) {
    const g = ecefToGeo(ecef[0] / 100, ecef[1] / 100, ecef[2] / 100)
    out.lat = g.lat
    out.lon = g.lon
    out.alt = g.alt
    const la = (g.lat * Math.PI) / 180
    const lo = (g.lon * Math.PI) / 180
    const [vx, vy, vz] = [vel[0] / 100, vel[1] / 100, vel[2] / 100]
    const east = -Math.sin(lo) * vx + Math.cos(lo) * vy
    const north = -Math.sin(la) * Math.cos(lo) * vx - Math.sin(la) * Math.sin(lo) * vy + Math.cos(la) * vz
    const up = Math.cos(la) * Math.cos(lo) * vx + Math.cos(la) * Math.sin(lo) * vy + Math.sin(la) * vz
    out.speed = Math.hypot(east, north)
    out.heading = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
    out.climb = up
  }
  if (meas && out.serial) {
    out.temperature = cal.temperature(out.serial, meas[0], meas[1], meas[2])
    out.humidityCounts = [meas[3], meas[4], meas[5]]
  }
  return out
}

// ---------------------------------------------------------------------------
// bit layer
// ---------------------------------------------------------------------------

const HEADER_BITS: number[] = []
for (const byte of RS41_HEADER_AIR) for (let b = 0; b < 8; b++) HEADER_BITS.push((byte >> b) & 1)
let HEADER_HI = 0
let HEADER_LO = 0
for (let i = 0; i < 64; i++) {
  if (i < 32) HEADER_HI = ((HEADER_HI << 1) | HEADER_BITS[i]) >>> 0
  else HEADER_LO = ((HEADER_LO << 1) | HEADER_BITS[i]) >>> 0
}

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

/** Header bit errors forgiven. The code downstream catches a false start. */
const HEADER_SLACK = 4
const FRAME_BITS = RS41_EXT_LEN * 8

/**
 * Turns the output of an fm discriminator into frames.
 *
 * Feed it frequency samples at any rate of a few samples a symbol or more.
 * A zero crossing loop keeps the bit clock, a slow mean takes out the
 * carrier offset, and the header is looked for in both polarities, since an
 * fm demodulator may hand the tones over either way round.
 */
export class Rs41Demod {
  onFrame: ((air: Uint8Array, at: number) => void) | null = null

  private readonly sps: number
  private readonly smooth: Float32Array
  private sPos = 0
  private sSum = 0
  private dc = 0
  private readonly dcAlpha: number
  private phase = 0
  private prev = 0
  private shiftLo = 0
  private shiftHi = 0
  private collecting = false
  private invert = false
  private readonly bits = new Uint8Array(FRAME_BITS)
  private n = 0
  private count = 0

  /** `smoothing` is the averaging window in symbols ahead of the slicer. */
  constructor(sampleRate: number, smoothing = 1) {
    this.sps = sampleRate / RS41_BAUD
    this.smooth = new Float32Array(Math.max(1, Math.round(this.sps * smoothing)))
    this.dcAlpha = 1 / (this.sps * 128)
  }

  /** Samples seen, for timing frames. */
  get samples(): number {
    return this.count
  }

  push(x: number): void {
    this.count++
    this.sSum += x - this.smooth[this.sPos]
    this.smooth[this.sPos] = x
    this.sPos = (this.sPos + 1) % this.smooth.length
    const raw = this.sSum / this.smooth.length
    this.dc += (raw - this.dc) * this.dcAlpha
    const y = raw - this.dc

    // the bit boundary sits at phase 0, decisions at phase one half.
    const step = 1 / this.sps
    const was = this.phase
    this.phase += step
    if ((y > 0) !== (this.prev > 0)) {
      // a transition belongs on a boundary: nudge the clock toward it.
      const frac = this.prev === y ? 0.5 : this.prev / (this.prev - y)
      let err = was + frac * step
      if (err > 0.5) err -= 1
      this.phase -= err * 0.03
    }
    if (was < 0.5 && this.phase >= 0.5) this.bit(y)
    if (this.phase >= 1) this.phase -= 1
    if (this.phase < 0) this.phase += 1
    this.prev = y
  }

  private bit(y: number): void {
    const b = y > 0 ? 1 : 0
    if (this.collecting) {
      this.bits[this.n++] = this.invert ? b ^ 1 : b
      if (this.n === FRAME_BITS) {
        this.collecting = false
        this.emit()
      }
      return
    }
    // the last 64 bits, oldest first: shiftHi holds bits 0 to 31.
    this.shiftHi = ((this.shiftHi << 1) | (this.shiftLo >>> 31)) >>> 0
    this.shiftLo = ((this.shiftLo << 1) | b) >>> 0
    const diff = popcount(this.shiftHi ^ HEADER_HI) + popcount(this.shiftLo ^ HEADER_LO)
    if (diff <= HEADER_SLACK || diff >= 64 - HEADER_SLACK) {
      this.invert = diff >= 64 - HEADER_SLACK
      this.collecting = true
      this.n = 64
      for (let i = 0; i < 64; i++) this.bits[i] = HEADER_BITS[i]
    }
  }

  private emit(): void {
    const air = new Uint8Array(RS41_EXT_LEN)
    for (let i = 0; i < FRAME_BITS; i++) if (this.bits[i]) air[i >> 3] |= 1 << (i & 7)
    this.shiftLo = 0
    this.shiftHi = 0
    this.onFrame?.(air, this.count)
  }
}

/**
 * The frame decoder over a stream of frequency samples, from an fm
 * discriminator or from a receiver's fm audio.
 *
 * Two slicers run on the same samples, one averaging over a whole symbol and
 * one over half. The whole symbol keeps more noise out, the half suits audio
 * that a radio already filtered. A frame both find is reported once.
 */
export class Rs41Decoder {
  onFrame: ((f: Rs41Frame) => void) | null = null
  /** Once per frame whose header was found, before it is read. */
  onHeader: (() => void) | null = null
  /** Headers found whose frame neither corrected nor checked. */
  failed = 0
  readonly calibration: Rs41Calibration

  private readonly demods: Rs41Demod[]
  private readonly sps: number
  private lastAt = -Infinity
  private lastOk = false
  private count = 0

  constructor(sampleRate: number, calibration = new Rs41Calibration()) {
    this.calibration = calibration
    this.sps = sampleRate / RS41_BAUD
    this.demods = [new Rs41Demod(sampleRate, 1), new Rs41Demod(sampleRate, 0.5)]
    for (const d of this.demods) d.onFrame = (air) => this.frame(air)
  }

  push(hz: number): void {
    this.count++
    for (let k = 0; k < this.demods.length; k++) this.demods[k].push(hz)
  }

  private frame(air: Uint8Array): void {
    // the slicers end the same frame within a few symbols of each other.
    const again = this.count - this.lastAt < this.sps * 400
    if (again && this.lastOk) return
    if (!again) {
      this.lastAt = this.count
      this.lastOk = false
      this.onHeader?.()
    }
    const f = parseRs41(air, this.calibration)
    if (!f) {
      if (!again) this.failed++
      return
    }
    if (again) this.failed--
    this.lastOk = true
    this.onFrame?.(f)
  }
}

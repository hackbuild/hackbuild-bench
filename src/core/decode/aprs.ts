/**
 * APRS over AX.25.
 *
 * The air interface is Bell 202 afsk at 1200 baud, 1200 Hz for mark and
 * 2200 Hz for space, nrzi coded and wrapped in hdlc frames that sit between
 * 0x7e flags with a zero stuffed after every five ones. Inside the frame is an
 * ax.25 ui frame, and inside that an aprs information field carrying a
 * position, a message, a status, or telemetry.
 *
 * In north america this all happens on 144.390 MHz fm. Elsewhere it is
 * 144.800 MHz or 145.175 MHz.
 */

import { DcBlock, LinearResampler, ToneCorrelator } from './signal'
import { LowPass } from '@/core/dsp/demod'

export const APRS_MARK_HZ = 1200
export const APRS_SPACE_HZ = 2200
export const APRS_BAUD = 1200

/** The slicer runs at a fixed rate so its window is exactly one symbol. */
const WORK_RATE = 19200
const WINDOW = WORK_RATE / APRS_BAUD

export interface AprsMessage {
  to: string
  text: string
  /** Sequence number the sender wants acked. */
  number?: string
}

export type AprsKind =
  | 'position'
  | 'mic-e'
  | 'message'
  | 'status'
  | 'object'
  | 'telemetry'
  | 'other'

export interface AprsPacket {
  id: string
  at: number
  /** Sending station, callsign with ssid when it has one. */
  source: string
  destination: string
  path: string[]
  control: number
  pid: number
  /** The information field as sent, one character per byte. */
  info: string
  /** The frame without its two check bytes. */
  bytes: Uint8Array
  kind: AprsKind
  latitude?: number
  longitude?: number
  /** Table id then symbol code, for example '/>' for a car. */
  symbol?: string
  comment?: string
  courseDeg?: number
  speedKnots?: number
  altitudeFt?: number
  message?: AprsMessage
  status?: string
  object?: string
  /** Set when a field was recognised but could not be turned into a value. */
  note?: string
}

// ---------------------------------------------------------------------------
// frame layer
// ---------------------------------------------------------------------------

/** X.25 frame check sequence, the one ax.25 puts at the end of every frame. */
export function ax25Fcs(bytes: Uint8Array, len: number): number {
  let crc = 0xffff
  for (let i = 0; i < len; i++) {
    crc ^= bytes[i]
    for (let b = 0; b < 8; b++) {
      crc = crc & 1 ? (crc >> 1) ^ 0x8408 : crc >> 1
    }
  }
  return ~crc & 0xffff
}

function latin1(b: Uint8Array, from: number, to: number): string {
  let s = ''
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i])
  return s
}

interface Ax25Address {
  call: string
  ssid: number
  last: boolean
  repeated: boolean
}

function readAddress(b: Uint8Array, off: number): Ax25Address | null {
  if (off + 7 > b.length) return null
  let call = ''
  for (let i = 0; i < 6; i++) {
    const c = b[off + i] >> 1
    if (c === 0x20) continue
    if (c < 0x30 || c > 0x5a) return null
    call += String.fromCharCode(c)
  }
  if (!call) return null
  const tail = b[off + 6]
  return {
    call,
    ssid: (tail >> 1) & 0x0f,
    last: (tail & 1) === 1,
    repeated: (tail & 0x80) !== 0,
  }
}

function formatAddress(a: Ax25Address): string {
  return a.ssid ? `${a.call}-${a.ssid}` : a.call
}

export interface Ax25Frame {
  source: string
  destination: string
  /** Raw destination callsign without the ssid, which mic-e encodes into. */
  destinationCall: string
  path: string[]
  control: number
  pid: number
  info: string
  bytes: Uint8Array
}

/** Parses a de-stuffed frame whose last two bytes are the check sequence. */
export function parseAx25(frame: Uint8Array): Ax25Frame | null {
  if (frame.length < 18) return null
  const len = frame.length - 2
  const want = frame[len] | (frame[len + 1] << 8)
  if (ax25Fcs(frame, len) !== want) return null

  const dest = readAddress(frame, 0)
  const src = readAddress(frame, 7)
  if (!dest || !src) return null

  const path: string[] = []
  let off = 14
  let end = src.last
  while (!end && off + 7 <= len) {
    const hop = readAddress(frame, off)
    if (!hop) return null
    path.push(formatAddress(hop) + (hop.repeated ? '*' : ''))
    end = hop.last
    off += 7
  }
  if (!end || off + 2 > len) return null

  return {
    source: formatAddress(src),
    destination: formatAddress(dest),
    destinationCall: dest.call,
    path,
    control: frame[off],
    pid: frame[off + 1],
    info: latin1(frame, off + 2, len),
    bytes: frame.subarray(0, len),
  }
}

// ---------------------------------------------------------------------------
// aprs information field
// ---------------------------------------------------------------------------

function base91(text: string): number {
  let v = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) - 33
    if (c < 0 || c > 90) return NaN
    v = v * 91 + c
  }
  return v
}

interface PositionFields {
  latitude: number
  longitude: number
  symbol: string
  rest: string
  courseDeg?: number
  speedKnots?: number
}

function parseUncompressed(s: string): PositionFields | null {
  if (s.length < 19) return null
  const lat = /^(\d{2})([\d ]{2})\.([\d ]{2})([NS])$/.exec(s.slice(0, 8))
  const lon = /^(\d{3})([\d ]{2})\.([\d ]{2})([EW])$/.exec(s.slice(9, 18))
  if (!lat || !lon) return null
  const blank = (t: string) => Number(t.replace(/ /g, '0'))

  let la = Number(lat[1]) + (blank(lat[2]) + blank(lat[3]) / 100) / 60
  let lo = Number(lon[1]) + (blank(lon[2]) + blank(lon[3]) / 100) / 60
  if (lat[4] === 'S') la = -la
  if (lon[4] === 'W') lo = -lo

  return { latitude: la, longitude: lo, symbol: `${s[8]}${s[18]}`, rest: s.slice(19) }
}

function parseCompressed(s: string): PositionFields | null {
  if (s.length < 13) return null
  if (!/[/\\A-Za-j]/.test(s[0])) return null
  const y = base91(s.slice(1, 5))
  const x = base91(s.slice(5, 9))
  if (!Number.isFinite(y) || !Number.isFinite(x)) return null

  const out: PositionFields = {
    latitude: 90 - y / 380926,
    longitude: -180 + x / 190463,
    symbol: `${s[0]}${s[9]}`,
    rest: s.slice(13),
  }
  const c = s.charCodeAt(10) - 33
  const d = s.charCodeAt(11) - 33
  if (c >= 0 && c <= 89 && d >= 0) {
    out.courseDeg = c * 4
    out.speedKnots = Math.round(1.08 ** d - 1)
  }
  return out
}

function parsePosition(s: string): PositionFields | null {
  return parseUncompressed(s) ?? parseCompressed(s)
}

/**
 * Mic-E splits the position across both ends of the frame: latitude and the
 * hemisphere bits ride in the destination callsign, longitude and the course
 * ride in the first bytes of the information field.
 */
function parseMicE(destinationCall: string, info: string): Partial<AprsPacket> | null {
  if (destinationCall.length !== 6 || info.length < 9) return null

  let digits = ''
  let north = false
  let offset = false
  let west = false
  for (let i = 0; i < 6; i++) {
    const c = destinationCall.charCodeAt(i)
    let digit: number
    let bit: number
    if (c >= 0x30 && c <= 0x39) {
      digit = c - 0x30
      bit = 0
    } else if (c >= 0x41 && c <= 0x4a) {
      digit = c - 0x41
      bit = 1
    } else if (c >= 0x50 && c <= 0x59) {
      digit = c - 0x50
      bit = 1
    } else if (c === 0x4c) {
      digit = 0
      bit = 0
    } else if (c === 0x4b || c === 0x5a) {
      digit = 0
      bit = 1
    } else {
      return null
    }
    digits += String(digit)
    if (i === 3) north = bit === 1
    if (i === 4) offset = bit === 1
    if (i === 5) west = bit === 1
  }

  let latitude = Number(digits.slice(0, 2)) + Number(`${digits.slice(2, 4)}.${digits.slice(4, 6)}`) / 60
  if (!north) latitude = -latitude

  let deg = info.charCodeAt(1) - 28
  if (offset) deg += 100
  if (deg >= 180 && deg <= 189) deg -= 80
  else if (deg >= 190 && deg <= 199) deg -= 190
  let min = info.charCodeAt(2) - 28
  if (min >= 60) min -= 60
  const hun = info.charCodeAt(3) - 28
  let longitude = deg + (min + hun / 100) / 60
  if (west) longitude = -longitude

  let speed = (info.charCodeAt(4) - 28) * 10
  const dc = info.charCodeAt(5) - 28
  speed += Math.floor(dc / 10)
  if (speed >= 800) speed -= 800
  let course = (dc % 10) * 100 + (info.charCodeAt(6) - 28)
  if (course >= 400) course -= 400

  return {
    kind: 'mic-e',
    latitude,
    longitude,
    symbol: `${info[8]}${info[7]}`,
    speedKnots: speed,
    courseDeg: course,
    comment: info.slice(9).trim() || undefined,
  }
}

/** Pulls course, speed, and altitude off the front of a comment. */
function splitComment(rest: string): Pick<AprsPacket, 'comment' | 'courseDeg' | 'speedKnots' | 'altitudeFt'> {
  let text = rest
  const out: Pick<AprsPacket, 'comment' | 'courseDeg' | 'speedKnots' | 'altitudeFt'> = {}

  const cse = /^(\d{3})\/(\d{3})/.exec(text)
  if (cse) {
    out.courseDeg = Number(cse[1])
    out.speedKnots = Number(cse[2])
    text = text.slice(7)
  }
  const alt = /\/A=(-?\d{6})/.exec(text)
  if (alt) {
    out.altitudeFt = Number(alt[1])
    text = text.replace(alt[0], '')
  }
  const comment = text.trim()
  if (comment) out.comment = comment
  return out
}

export function parseAprsInfo(info: string, destinationCall: string): Partial<AprsPacket> {
  if (!info) return { kind: 'other' }
  const type = info[0]

  if (type === '`' || type === "'" || type === '\x1c' || type === '\x1d') {
    const mic = parseMicE(destinationCall, info)
    if (mic) return mic
    return { kind: 'mic-e', note: 'mic-e position did not parse' }
  }

  if (type === '!' || type === '=' || type === '/' || type === '@') {
    // the timestamped forms carry seven characters of time first.
    const body = type === '/' || type === '@' ? info.slice(8) : info.slice(1)
    const pos = parsePosition(body)
    if (!pos) return { kind: 'position', note: 'position field did not parse' }
    return {
      kind: 'position',
      latitude: pos.latitude,
      longitude: pos.longitude,
      symbol: pos.symbol,
      courseDeg: pos.courseDeg,
      speedKnots: pos.speedKnots,
      ...splitComment(pos.rest),
    }
  }

  if (type === ':') {
    const to = info.slice(1, 10).trim()
    const body = info.slice(11)
    const seq = /\{(\w+)$/.exec(body)
    return {
      kind: 'message',
      message: {
        to,
        text: seq ? body.slice(0, seq.index) : body,
        number: seq?.[1],
      },
    }
  }

  if (type === '>') return { kind: 'status', status: info.slice(1).trim() }

  if (type === ';' || type === ')') {
    const named = type === ';' ? info.slice(1, 10).trim() : /^\)([^!_]+)[!_]/.exec(info)?.[1]
    const body = type === ';' ? info.slice(18) : info.slice((named?.length ?? 0) + 2)
    const pos = parsePosition(body)
    return {
      kind: 'object',
      object: named ?? undefined,
      ...(pos
        ? {
            latitude: pos.latitude,
            longitude: pos.longitude,
            symbol: pos.symbol,
            ...splitComment(pos.rest),
          }
        : { note: 'object has no readable position' }),
    }
  }

  if (info.startsWith('T#')) return { kind: 'telemetry', comment: info.slice(2).trim() }

  return { kind: 'other', comment: info.trim() || undefined }
}

// ---------------------------------------------------------------------------
// geometry the panel needs to place a station against a home position
// ---------------------------------------------------------------------------

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = 6371
  const p = Math.PI / 180
  const a =
    Math.sin(((lat2 - lat1) * p) / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(((lon2 - lon1) * p) / 2) ** 2
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(a)))
}

export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p = Math.PI / 180
  const y = Math.sin((lon2 - lon1) * p) * Math.cos(lat2 * p)
  const x =
    Math.cos(lat1 * p) * Math.sin(lat2 * p) -
    Math.sin(lat1 * p) * Math.cos(lat2 * p) * Math.cos((lon2 - lon1) * p)
  return (Math.atan2(y, x) / p + 360) % 360
}

// ---------------------------------------------------------------------------

export class AprsDecoder {
  onPacket: ((packet: AprsPacket) => void) | null = null
  /** Frames that arrived with a bad check sequence, counted not discarded. */
  onBadFrame: ((bytes: Uint8Array) => void) | null = null

  private sampleRate = 0
  private dc = new DcBlock()
  private resamp = new LinearResampler(1)
  private corr = new ToneCorrelator(APRS_MARK_HZ, APRS_SPACE_HZ, WORK_RATE, WINDOW)
  private lp = new LowPass(APRS_BAUD, WORK_RATE)

  private peakP = 0
  private peakN = 0
  private phase = 0
  private lastLevel = 1
  private lastSymbol = 1

  private hist = 0
  private ones = 0
  private inFrame = false
  private byteAcc = 0
  private bitCount = 0
  private frame: number[] = []

  private counter = 0
  private bad = 0

  get badFrames(): number {
    return this.bad
  }

  reset(): void {
    this.dc.reset()
    this.resamp.reset()
    this.corr.reset()
    this.lp = new LowPass(APRS_BAUD, WORK_RATE)
    this.peakP = 0
    this.peakN = 0
    this.phase = 0
    this.lastLevel = 1
    this.lastSymbol = 1
    this.hist = 0
    this.ones = 0
    this.inFrame = false
    this.byteAcc = 0
    this.bitCount = 0
    this.frame = []
  }

  feed(audio: Float32Array, sampleRate: number): void {
    if (audio.length === 0) return
    if (sampleRate !== this.sampleRate) {
      this.sampleRate = sampleRate
      this.reset()
      this.resamp.setStep(sampleRate / WORK_RATE)
    }

    const work = this.resamp.process(this.dc.process(audio))
    if (work.length === 0) return
    const diff = this.lp.process(this.corr.process(work))

    for (let i = 0; i < diff.length; i++) {
      const v = diff[i]
      // the two tones rarely arrive at the same level, so the decision point
      // tracks the middle of the swing instead of sitting at zero.
      this.peakP += (v - this.peakP) * (v > this.peakP ? 0.2 : 0.0004)
      this.peakN += (v - this.peakN) * (v < this.peakN ? 0.2 : 0.0004)
      const level = v > (this.peakP + this.peakN) / 2 ? 1 : 0

      if (level !== this.lastLevel) {
        this.lastLevel = level
        // a transition says where the middle of the bit is, so the sampling
        // instant is pulled half a symbol away from it.
        this.phase += (0.5 - this.phase) * 0.35
      }
      this.phase += APRS_BAUD / WORK_RATE
      if (this.phase >= 1) {
        this.phase -= 1
        this.pushSymbol(level)
      }
    }
  }

  /** nrzi: no change on the wire means a one. */
  private pushSymbol(level: number): void {
    const bit = level === this.lastSymbol ? 1 : 0
    this.lastSymbol = level
    this.pushBit(bit)
  }

  private pushBit(bit: number): void {
    this.hist = ((this.hist >> 1) | (bit ? 0x80 : 0)) & 0xff
    if (this.hist === 0x7e) {
      this.closeFrame()
      this.inFrame = true
      this.frame = []
      this.byteAcc = 0
      this.bitCount = 0
      this.ones = 0
      return
    }

    if (bit) {
      this.ones++
      if (this.ones > 6) {
        this.inFrame = false
        this.frame = []
        this.ones = 0
        return
      }
    } else {
      if (this.ones === 5) {
        this.ones = 0
        return
      }
      this.ones = 0
    }

    if (!this.inFrame) return
    this.byteAcc = (this.byteAcc >> 1) | (bit ? 0x80 : 0)
    if (++this.bitCount === 8) {
      this.frame.push(this.byteAcc)
      this.byteAcc = 0
      this.bitCount = 0
      if (this.frame.length > 400) {
        this.inFrame = false
        this.frame = []
      }
    }
  }

  private closeFrame(): void {
    if (!this.inFrame || this.frame.length < 18) return
    const bytes = Uint8Array.from(this.frame)
    this.frame = []
    const parsed = parseAx25(bytes)
    if (!parsed) {
      this.bad++
      this.onBadFrame?.(bytes)
      return
    }
    this.emit(parsed)
  }

  private emit(frame: Ax25Frame): void {
    const packet: AprsPacket = {
      id: `aprs-${++this.counter}`,
      at: Date.now(),
      source: frame.source,
      destination: frame.destination,
      path: frame.path,
      control: frame.control,
      pid: frame.pid,
      info: frame.info,
      bytes: frame.bytes,
      kind: 'other',
      ...parseAprsInfo(frame.info, frame.destinationCall),
    }
    this.onPacket?.(packet)
  }
}

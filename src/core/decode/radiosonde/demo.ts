/**
 * A synthetic RS41 for demo mode.
 *
 * Builds whole frames the way the sonde does, blocks with their crcs, both
 * Reed-Solomon codewords, the whitening mask, and modulates them as gfsk at
 * 4800 baud. The IQ is rendered for whatever window the panel tunes, so the
 * scan, the lock and the decode all run the same as on the air. The flight
 * starts 25 km west of the receiver and climbs at 5 m/s while drifting east.
 */

import { RS41_BAUD, RS41_MASK, RS41_STD_LEN, RS41_EXT_LEN, crc16 } from './rs41'
import { RS_K, RS_N, RS_PARITY, rsEncode } from './reedsolomon'

export const DEMO_SONDE_HZ = 403_010_000
const DEVIATION_HZ = 2100
const SERIAL = 'S3140592'
/** Synthetic references and polynomial, so temperature calibrates in the demo. */
const RF1 = 750
const RF2 = 1100
const CO = [-243.911, 0.187654, 8.2e-6]
const COUNTS_PER_OHM = 300

function calibrationTable(): Uint8Array {
  const t = new Uint8Array(51 * 16)
  const v = new DataView(t.buffer)
  v.setFloat32(61, RF1, true)
  v.setFloat32(65, RF2, true)
  v.setFloat32(77, CO[0], true)
  v.setFloat32(81, CO[1], true)
  v.setFloat32(85, CO[2], true)
  v.setFloat32(89, 1, true)
  v.setFloat32(93, 0, true)
  v.setFloat32(97, 0, true)
  return t
}

function geoToEcef(latDeg: number, lonDeg: number, alt: number): [number, number, number] {
  const a = 6378137
  const f = 1 / 298.257223563
  const e2 = f * (2 - f)
  const la = (latDeg * Math.PI) / 180
  const lo = (lonDeg * Math.PI) / 180
  const n = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2)
  return [
    (n + alt) * Math.cos(la) * Math.cos(lo),
    (n + alt) * Math.cos(la) * Math.sin(lo),
    (n * (1 - e2) + alt) * Math.sin(la),
  ]
}

function enuToEcef(latDeg: number, lonDeg: number, e: number, n: number, u: number): [number, number, number] {
  const la = (latDeg * Math.PI) / 180
  const lo = (lonDeg * Math.PI) / 180
  return [
    -Math.sin(lo) * e - Math.sin(la) * Math.cos(lo) * n + Math.cos(la) * Math.cos(lo) * u,
    Math.cos(lo) * e - Math.sin(la) * Math.sin(lo) * n + Math.cos(la) * Math.sin(lo) * u,
    Math.cos(la) * n + Math.sin(la) * u,
  ]
}

class Writer {
  readonly b = new Uint8Array(RS41_EXT_LEN)
  pos = 57

  block(id: number, data: Uint8Array): void {
    const at = this.pos
    this.b[at] = id
    this.b[at + 1] = data.length
    this.b.set(data, at + 2)
    const c = crc16(this.b, at + 2, data.length)
    this.b[at + 2 + data.length] = c & 0xff
    this.b[at + 3 + data.length] = c >> 8
    this.pos += 4 + data.length
  }
}

/** One frame as it goes on air: scrambled, 320 bytes. */
export function buildRs41Frame(o: {
  frame: number
  lat: number
  lon: number
  alt: number
  east: number
  north: number
  up: number
  tempC: number
  at: Date
  cal: Uint8Array
}): Uint8Array {
  const w = new Writer()
  const hdr = [0x86, 0x35, 0xf4, 0x40, 0x93, 0xdf, 0x1a, 0x60]
  w.b.set(hdr, 0)
  w.b[56] = 0x0f

  const st = new Uint8Array(40)
  st[0] = o.frame & 0xff
  st[1] = o.frame >> 8
  for (let i = 0; i < 8; i++) st[2 + i] = SERIAL.charCodeAt(i)
  st[10] = 30
  const frag = o.frame % 51
  st[23] = frag
  st.set(o.cal.subarray(frag * 16, frag * 16 + 16), 24)
  w.block(0x79, st)

  const meas = new Uint8Array(42)
  // solve the sensor polynomial backwards for the resistance at this temperature.
  const r = (-CO[1] + Math.sqrt(CO[1] ** 2 - 4 * CO[2] * (CO[0] - o.tempC))) / (2 * CO[2])
  const counts = [r * COUNTS_PER_OHM, RF1 * COUNTS_PER_OHM, RF2 * COUNTS_PER_OHM]
  counts.forEach((c, i) => {
    const v = Math.round(c)
    meas[3 * i] = v & 0xff
    meas[3 * i + 1] = (v >> 8) & 0xff
    meas[3 * i + 2] = (v >> 16) & 0xff
  })
  w.block(0x7a, meas)

  const gps = new Uint8Array(30)
  const gpsMs = o.at.getTime() + 18_000 - Date.UTC(1980, 0, 6)
  const week = Math.floor(gpsMs / 604_800_000)
  const tow = gpsMs - week * 604_800_000
  const gv = new DataView(gps.buffer)
  gv.setUint16(0, week, true)
  gv.setUint32(2, tow, true)
  w.block(0x7c, gps)

  const pos = new Uint8Array(21)
  const pv = new DataView(pos.buffer)
  const [x, y, z] = geoToEcef(o.lat, o.lon, o.alt)
  const [vx, vy, vz] = enuToEcef(o.lat, o.lon, o.east, o.north, o.up)
  pv.setInt32(0, Math.round(x * 100), true)
  pv.setInt32(4, Math.round(y * 100), true)
  pv.setInt32(8, Math.round(z * 100), true)
  pv.setInt16(12, Math.round(vx * 100), true)
  pv.setInt16(14, Math.round(vy * 100), true)
  pv.setInt16(16, Math.round(vz * 100), true)
  pos[18] = 9
  pos[19] = 3
  pos[20] = 15
  w.block(0x7b, pos)

  w.block(0x76, new Uint8Array(RS41_STD_LEN - w.pos - 4))

  for (let c = 0; c < 2; c++) {
    const cw = new Uint8Array(RS_N)
    for (let i = 0; i < RS_K; i++) cw[RS_PARITY + i] = w.b[56 + 2 * i + c]
    rsEncode(cw)
    for (let i = 0; i < RS_PARITY; i++) w.b[8 + c * RS_PARITY + i] = cw[i]
  }
  const air = new Uint8Array(RS41_STD_LEN)
  for (let i = 0; i < RS41_STD_LEN; i++) air[i] = w.b[i] ^ RS41_MASK[i % 64]
  return air
}

function erf(x: number): number {
  const s = x < 0 ? -1 : 1
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a))
}

/** The instantaneous frequency of a frame, gaussian shaped at bt 0.5, sampled at `rate`. */
function frequencyTrack(air: Uint8Array, rate: number): Float32Array {
  const bits: number[] = []
  for (let i = 0; i < 40; i++) bits.push(i & 1)
  for (const byte of air) for (let b = 0; b < 8; b++) bits.push((byte >> b) & 1)
  const sps = rate / RS41_BAUD
  const n = Math.ceil(bits.length * sps)
  const out = new Float32Array(n)
  const k = Math.PI * 0.5 * Math.sqrt(2 / Math.LN2)
  for (let i = 0; i < n; i++) {
    const t = i / sps
    const c = Math.floor(t)
    let f = 0
    for (let j = c - 2; j <= c + 2; j++) {
      if (j < 0 || j >= bits.length) continue
      const u = t - j - 0.5
      f += (bits[j] ? 1 : -1) * 0.5 * (erf(k * (u + 0.5)) - erf(k * (u - 0.5)))
    }
    out[i] = f * DEVIATION_HZ
  }
  return out
}

const TRACK_RATE = 48_000

export class SondeDemoSource {
  readonly frequencyHz = DEMO_SONDE_HZ
  private readonly lat0: number
  private readonly lon0: number
  private readonly cal = calibrationTable()
  private t = 0
  private phase = 0
  // the fragments the temperature needs come round a few seconds after a demo scan locks.
  private frameNo = 4226
  private track: Float32Array | null = null
  private trackStart = 0
  private nextAt = 0.1
  private seed = 11
  private readonly started = Date.now()

  constructor(lat: number, lon: number) {
    this.lat0 = lat
    this.lon0 = lon
  }

  private noise(): number {
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648
    return this.seed / 2147483648 - 0.5
  }

  private nextFrame(at: number): void {
    const secs = at
    const east = 8
    const up = 5
    const alt = 1500 + up * secs
    const xKm = -25 + (east * secs) / 1000
    const lat = this.lat0 + 0.004
    const lon = this.lon0 + xKm / (111.32 * Math.cos((this.lat0 * Math.PI) / 180))
    const air = buildRs41Frame({
      frame: this.frameNo++,
      lat,
      lon,
      alt,
      east,
      north: 0.4,
      up,
      tempC: 15 - 6.5 * (alt / 1000),
      at: new Date(this.started + secs * 1000),
      cal: this.cal,
    })
    this.track = frequencyTrack(air, TRACK_RATE)
    this.trackStart = at
  }

  /** IQ for the next `ms`, as a window at `centerHz` and `rate` would see it. */
  read(ms: number, centerHz: number, rate: number): Float32Array {
    const n = Math.round((rate * ms) / 1000)
    const out = new Float32Array(n * 2)
    const offset = this.frequencyHz - centerHz
    const inWindow = Math.abs(offset) < rate / 2 - 10_000
    const amp = 0.08
    for (let i = 0; i < n; i++) {
      const t = this.t + i / rate
      if (t >= this.nextAt) {
        this.nextFrame(this.nextAt)
        this.nextAt += 1
      }
      let f = 0
      let on = false
      if (this.track) {
        const k = (t - this.trackStart) * TRACK_RATE
        if (k >= 0 && k < this.track.length - 1) {
          on = true
          const j = Math.floor(k)
          f = this.track[j] + (this.track[j + 1] - this.track[j]) * (k - j)
        }
      }
      out[i * 2] = this.noise() * 0.05
      out[i * 2 + 1] = this.noise() * 0.05
      if (on && inWindow) {
        this.phase += (2 * Math.PI * (offset + f)) / rate
        out[i * 2] += amp * Math.cos(this.phase)
        out[i * 2 + 1] += amp * Math.sin(this.phase)
      }
    }
    this.phase %= 2 * Math.PI
    this.t += n / rate
    return out
  }
}

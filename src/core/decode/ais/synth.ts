/**
 * Builds AIS transmissions: message bits from fields, then the gmsk burst a
 * transponder would put on the air. Demo mode feeds these through the same
 * receiver a radio does, so a decode on screen went through the whole chain.
 */

import { ax25Fcs } from '../aprs'
import { AIS_BAUD } from './receiver'

class BitWriter {
  private readonly bits: number[] = []

  u(value: number, width: number): this {
    for (let i = width - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2)
    return this
  }

  s(value: number, width: number): this {
    return this.u(value < 0 ? value + 2 ** width : value, width)
  }

  text(value: string, chars: number): this {
    const up = value.toUpperCase().padEnd(chars, '@').slice(0, chars)
    for (const ch of up) {
      const c = ch.charCodeAt(0)
      this.u(c >= 64 ? c - 64 : c >= 32 && c < 64 ? c : 0, 6)
    }
    return this
  }

  /** Packs to bytes, zero filled to a whole byte as the air interface needs. */
  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8))
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3] |= 0x80 >> (i & 7)
    })
    return out
  }
}

const lon = (deg: number) => Math.round(deg * 600000)
const lat = (deg: number) => Math.round(deg * 600000)

export interface SynthPosition {
  mmsi: number
  lat: number
  lon: number
  sog: number
  cog: number
  heading: number
  second: number
}

export function encodePositionA(p: SynthPosition, status = 0): Uint8Array {
  return new BitWriter()
    .u(1, 6).u(0, 2).u(p.mmsi, 30).u(status, 4).s(0, 8).u(Math.round(p.sog * 10), 10).u(1, 1)
    .s(lon(p.lon), 28).s(lat(p.lat), 27).u(Math.round(p.cog * 10), 12).u(p.heading, 9).u(p.second, 6)
    .u(0, 2).u(0, 3).u(0, 1).u(0, 19)
    .bytes()
}

export function encodePositionB(p: SynthPosition): Uint8Array {
  return new BitWriter()
    .u(18, 6).u(0, 2).u(p.mmsi, 30).u(0, 8).u(Math.round(p.sog * 10), 10).u(1, 1)
    .s(lon(p.lon), 28).s(lat(p.lat), 27).u(Math.round(p.cog * 10), 12).u(p.heading, 9).u(p.second, 6)
    .u(0, 2).u(1, 1).u(0, 1).u(1, 1).u(1, 1).u(1, 1).u(0, 1).u(0, 1).u(0, 20)
    .bytes()
}

export function encodeExtendedB(p: SynthPosition, v: SynthStatic): Uint8Array {
  return new BitWriter()
    .u(19, 6).u(0, 2).u(p.mmsi, 30).u(0, 8).u(Math.round(p.sog * 10), 10).u(1, 1)
    .s(lon(p.lon), 28).s(lat(p.lat), 27).u(Math.round(p.cog * 10), 12).u(p.heading, 9).u(p.second, 6)
    .u(0, 4).text(v.name, 20).u(v.shipType, 8).u(10, 9).u(5, 9).u(2, 6).u(3, 6).u(1, 4).u(0, 1).u(1, 1).u(0, 1).u(0, 4)
    .bytes()
}

export interface SynthStatic {
  mmsi: number
  name: string
  callsign: string
  shipType: number
  destination: string
  imo?: number
}

export function encodeStatic(v: SynthStatic): Uint8Array {
  return new BitWriter()
    .u(5, 6).u(0, 2).u(v.mmsi, 30).u(0, 2).u(v.imo ?? 0, 30).text(v.callsign, 7).text(v.name, 20)
    .u(v.shipType, 8).u(120, 9).u(30, 9).u(10, 6).u(12, 6).u(1, 4)
    .u(10, 4).u(14, 5).u(6, 5).u(30, 6).u(85, 8).text(v.destination, 20).u(0, 1).u(0, 1)
    .bytes()
}

export function encodeStaticB(v: SynthStatic, part: 0 | 1): Uint8Array {
  const w = new BitWriter().u(24, 6).u(0, 2).u(v.mmsi, 30).u(part, 2)
  if (part === 0) return w.text(v.name, 20).u(0, 8).bytes()
  return w.u(v.shipType, 8).text('SRT', 3).u(1, 4).u(12345, 20).text(v.callsign, 7)
    .u(8, 9).u(4, 9).u(2, 6).u(2, 6).u(0, 6).bytes()
}

export function encodeBaseStation(mmsi: number, at: Date, latDeg: number, lonDeg: number): Uint8Array {
  return new BitWriter()
    .u(4, 6).u(0, 2).u(mmsi, 30).u(at.getUTCFullYear(), 14).u(at.getUTCMonth() + 1, 4).u(at.getUTCDate(), 5)
    .u(at.getUTCHours(), 5).u(at.getUTCMinutes(), 6).u(at.getUTCSeconds(), 6).u(1, 1)
    .s(lon(lonDeg), 28).s(lat(latDeg), 27).u(7, 4).u(0, 10).u(0, 1).u(0, 19)
    .bytes()
}

export function encodeAidToNav(mmsi: number, name: string, aidType: number, latDeg: number, lonDeg: number): Uint8Array {
  return new BitWriter()
    .u(21, 6).u(0, 2).u(mmsi, 30).u(aidType, 5).text(name, 20).u(1, 1)
    .s(lon(lonDeg), 28).s(lat(latDeg), 27).u(0, 30).u(7, 4).u(60, 6).u(0, 1).u(0, 8).u(0, 1).u(0, 1).u(0, 1).u(0, 1)
    .bytes()
}

/** The bits on air: ramp, training, flag, stuffed data and check, flag, buffer. */
function airBits(payload: Uint8Array): number[] {
  const fcs = ax25Fcs(payload, payload.length)
  const frame = new Uint8Array(payload.length + 2)
  frame.set(payload)
  frame[payload.length] = fcs & 0xff
  frame[payload.length + 1] = fcs >> 8
  const bits: number[] = []
  for (let i = 0; i < 8; i++) bits.push(1)
  for (let i = 0; i < 24; i++) bits.push(i & 1)
  const flag = [0, 1, 1, 1, 1, 1, 1, 0]
  bits.push(...flag)
  let ones = 0
  for (const byte of frame) {
    for (let b = 0; b < 8; b++) {
      const bit = (byte >> b) & 1
      bits.push(bit)
      ones = bit ? ones + 1 : 0
      if (ones === 5) {
        bits.push(0)
        ones = 0
      }
    }
  }
  bits.push(...flag)
  for (let i = 0; i < 8; i++) bits.push(1)
  return bits
}

/** Abramowitz and Stegun 7.1.26, good to about 1e-7. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a)
  return s * y
}

/**
 * Modulates one message as a gmsk burst, bt 0.4, index one half, at `rate`
 * and `offsetHz` from the centre. Returns interleaved I/Q with unit amplitude.
 */
export function aisBurst(payload: Uint8Array, rate: number, offsetHz: number, startPhase = 0): Float32Array {
  const bits = airBits(payload)
  // nrzi: a zero changes the frequency.
  const sym: number[] = []
  let level = 1
  for (const b of bits) {
    if (!b) level = -level
    sym.push(level)
  }
  const sps = rate / AIS_BAUD
  const n = Math.ceil(sym.length * sps)
  const out = new Float32Array(n * 2)
  const k = Math.PI * 0.4 * Math.sqrt(2 / Math.LN2)
  let phase = startPhase
  const carrier = (2 * Math.PI * offsetHz) / rate
  for (let i = 0; i < n; i++) {
    const t = i / sps
    let f = 0
    const c = Math.floor(t)
    for (let j = c - 3; j <= c + 3; j++) {
      if (j < 0 || j >= sym.length) continue
      const u = t - j - 0.5
      f += sym[j] * 0.5 * (erf(k * (u + 0.5)) - erf(k * (u - 0.5)))
    }
    phase += (Math.PI / 2) * (f / sps) + carrier
    // the ramp bits rise from silence, as a transmitter keys up over its first byte.
    const env = Math.min(1, t / 8, Math.max(0, (sym.length - t) / 8))
    out[i * 2] = env * Math.cos(phase)
    out[i * 2 + 1] = env * Math.sin(phase)
  }
  return out
}

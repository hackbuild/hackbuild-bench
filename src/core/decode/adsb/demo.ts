import { modesChecksum } from './crc'
import { cprEncode, destination } from './cpr'
import type { LatLon } from './cpr'

/**
 * Synthetic 1090 MHz traffic for demo mode.
 *
 * Builds real Mode S frames with their parity, for a handful of made up
 * aircraft flying straight lines around a centre point, and renders them as
 * 2.4 Msps IQ: pulses on a carrier with a random phase and a small frequency
 * offset, arriving at random fractions of a sample, under gaussian noise.
 * The decoder then demodulates them the way it would on the air, so what the
 * panel shows is a decode and not a table pasted in.
 */

const RATE = 2_400_000
/** Sub-samples per output sample. Six of them make one half bit. */
const OVER = 5
/** Longest reply, preamble plus 112 bits, with a little room. */
const BURST_S = 125e-6
const NOISE_LEN = 1 << 18
const AIS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ##### ###############0123456789######'

interface Fake {
  icao: number
  callsign: string
  squawk: string
  pos: LatLon
  altFt: number
  speedKt: number
  trackDeg: number
  climbFpm: number
  /** Linear amplitude at the receiver. */
  amp: number
  next: { pos: number; vel: number; ident: number; df11: number; df4: number; df5: number }
  odd: boolean
}

function setBits(msg: Uint8Array, first: number, width: number, value: number): void {
  for (let i = 0; i < width; i++) {
    const bit = (value / 2 ** (width - 1 - i)) & 1
    const b = first - 1 + i
    if (bit) msg[b >> 3] |= 0x80 >> (b & 7)
  }
}

/** Fills the parity, xored with an address for the address/parity formats. */
function seal(msg: Uint8Array, overlay = 0): Uint8Array {
  const n = msg.length
  msg[n - 3] = msg[n - 2] = msg[n - 1] = 0
  const p = (modesChecksum(msg, n * 8) ^ overlay) >>> 0
  msg[n - 3] = (p >> 16) & 0xff
  msg[n - 2] = (p >> 8) & 0xff
  msg[n - 1] = p & 0xff
  return msg
}

function ac12(alt: number): number {
  const n = Math.max(0, Math.round((alt + 1000) / 25))
  return ((n & 0x7f0) << 1) | 0x10 | (n & 0x0f)
}

function ac13(alt: number): number {
  const n = Math.max(0, Math.round((alt + 1000) / 25))
  return ((n << 2) & 0x1f80) | ((n << 1) & 0x20) | 0x10 | (n & 0x0f)
}

function id13(squawk: string): number {
  const [a, b, c, d] = squawk.split('').map((x) => Number(x))
  const bit = (v: number, k: number) => (v >> k) & 1
  return (
    (bit(c, 0) << 12) | (bit(a, 0) << 11) | (bit(c, 1) << 10) | (bit(a, 1) << 9) |
    (bit(c, 2) << 8) | (bit(a, 2) << 7) | (bit(b, 0) << 5) | (bit(d, 0) << 4) |
    (bit(b, 1) << 3) | (bit(d, 1) << 2) | (bit(b, 2) << 1) | bit(d, 2)
  )
}

function df17(icao: number): Uint8Array {
  const m = new Uint8Array(14)
  setBits(m, 1, 5, 17)
  setBits(m, 6, 3, 5)
  setBits(m, 9, 24, icao)
  return m
}

function identFrame(f: Fake): Uint8Array {
  const m = df17(f.icao)
  setBits(m, 33, 5, 4)
  setBits(m, 38, 3, 3)
  const cs = f.callsign.padEnd(8, ' ')
  for (let i = 0; i < 8; i++) setBits(m, 41 + i * 6, 6, Math.max(0, AIS.indexOf(cs[i])))
  return seal(m)
}

function positionFrame(f: Fake): Uint8Array {
  const m = df17(f.icao)
  setBits(m, 33, 5, 11)
  setBits(m, 41, 12, ac12(f.altFt))
  setBits(m, 54, 1, f.odd ? 1 : 0)
  const c = cprEncode(f.pos, f.odd)
  setBits(m, 55, 17, c.lat)
  setBits(m, 72, 17, c.lon)
  f.odd = !f.odd
  return seal(m)
}

function velocityFrame(f: Fake): Uint8Array {
  const m = df17(f.icao)
  setBits(m, 33, 5, 19)
  setBits(m, 38, 3, 1)
  const r = (f.trackDeg * Math.PI) / 180
  const ew = Math.round(Math.sin(r) * f.speedKt)
  const ns = Math.round(Math.cos(r) * f.speedKt)
  setBits(m, 46, 1, ew < 0 ? 1 : 0)
  setBits(m, 47, 10, Math.min(1023, Math.abs(ew) + 1))
  setBits(m, 57, 1, ns < 0 ? 1 : 0)
  setBits(m, 58, 10, Math.min(1023, Math.abs(ns) + 1))
  setBits(m, 68, 1, 1)
  setBits(m, 69, 1, f.climbFpm < 0 ? 1 : 0)
  setBits(m, 70, 9, Math.min(511, Math.round(Math.abs(f.climbFpm) / 64) + 1))
  return seal(m)
}

function allCallFrame(f: Fake): Uint8Array {
  const m = new Uint8Array(7)
  setBits(m, 1, 5, 11)
  setBits(m, 6, 3, 5)
  setBits(m, 9, 24, f.icao)
  return seal(m)
}

function altitudeReply(f: Fake): Uint8Array {
  const m = new Uint8Array(7)
  setBits(m, 1, 5, 4)
  setBits(m, 20, 13, ac13(f.altFt))
  return seal(m, f.icao)
}

function identityReply(f: Fake): Uint8Array {
  const m = new Uint8Array(7)
  setBits(m, 1, 5, 5)
  setBits(m, 20, 13, id13(f.squawk))
  return seal(m, f.icao)
}

const FLEET: Array<Pick<Fake, 'icao' | 'callsign' | 'squawk' | 'altFt' | 'speedKt' | 'climbFpm'> & { brg: number; km: number; trk: number }> = [
  { icao: 0xa1b2c3, callsign: 'SWA1471', squawk: '4521', altFt: 36000, speedKt: 452, climbFpm: 0, brg: 40, km: 70, trk: 250 },
  { icao: 0xa4c7e1, callsign: 'AAL2219', squawk: '6237', altFt: 11250, speedKt: 286, climbFpm: -1408, brg: 120, km: 28, trk: 300 },
  { icao: 0xa0f00d, callsign: 'N731HB', squawk: '1200', altFt: 4500, speedKt: 118, climbFpm: 0, brg: 200, km: 12, trk: 80 },
  { icao: 0xab1234, callsign: 'UAL884', squawk: '3315', altFt: 23400, speedKt: 391, climbFpm: 1856, brg: 290, km: 95, trk: 45 },
  { icao: 0xa77e55, callsign: 'FDX3920', squawk: '5502', altFt: 39000, speedKt: 474, climbFpm: 0, brg: 340, km: 160, trk: 170 },
  { icao: 0xa52f90, callsign: 'SKW5530', squawk: '2754', altFt: 17800, speedKt: 330, climbFpm: -960, brg: 75, km: 140, trk: 230 },
]

/** A burst due at a given time on the source clock. */
interface Pending {
  at: number
  frame: Uint8Array
  amp: number
}

export class AdsbDemoSource {
  readonly sampleRate = RATE
  private planes: Fake[]
  private t = 0
  private queue: Pending[] = []
  private phase = 0
  private freq: number
  private seed: number
  private spare: number | null = null
  private noise: number
  private centre: LatLon
  private noiseBuf: Float32Array | null = null

  constructor(centre: LatLon, seed = 1090) {
    this.seed = seed
    this.centre = centre
    this.noise = 0.012
    this.freq = (2 * Math.PI * 7000) / RATE
    this.planes = FLEET.map((p, i) => ({
      icao: p.icao,
      callsign: p.callsign,
      squawk: p.squawk,
      altFt: p.altFt,
      speedKt: p.speedKt,
      climbFpm: p.climbFpm,
      trackDeg: p.trk,
      pos: destination(centre, p.brg, p.km),
      amp: 0,
      odd: i % 2 === 1,
      next: {
        pos: this.rand() * 0.5,
        vel: this.rand() * 0.5,
        ident: this.rand() * 5,
        df11: this.rand(),
        df4: this.rand() * 2,
        df5: this.rand() * 3,
      },
    }))
    for (const p of this.planes) p.amp = this.amplitude(centre, p)
  }

  private rand(): number {
    // mulberry32, so a demo run is the same every time.
    let x = (this.seed = (this.seed + 0x6d2b79f5) | 0)
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }

  private gauss(): number {
    if (this.spare !== null) {
      const s = this.spare
      this.spare = null
      return s
    }
    const u = Math.max(1e-12, this.rand())
    const v = this.rand()
    const r = Math.sqrt(-2 * Math.log(u))
    this.spare = r * Math.sin(2 * Math.PI * v)
    return r * Math.cos(2 * Math.PI * v)
  }

  /**
   * Gaussian draws are the costly part of rendering, so a block of them is
   * made once and walked from a random start for each read.
   */
  private noiseTable(): Float32Array {
    if (!this.noiseBuf) {
      this.noiseBuf = new Float32Array(NOISE_LEN)
      for (let i = 0; i < NOISE_LEN; i++) this.noiseBuf[i] = this.gauss()
    }
    return this.noiseBuf
  }

  private amplitude(centre: LatLon, p: Fake): number {
    const dLat = (p.pos.lat - centre.lat) * 111
    const dLon = (p.pos.lon - centre.lon) * 111 * Math.cos((centre.lat * Math.PI) / 180)
    const km = Math.max(5, Math.hypot(dLat, dLon))
    return Math.min(0.6, 0.6 * (15 / km))
  }

  private schedule(until: number): void {
    for (const p of this.planes) {
      const n = p.next
      const add = (at: number, frame: Uint8Array) => this.queue.push({ at, frame, amp: p.amp })
      while (n.pos < until) {
        add(n.pos, positionFrame(p))
        n.pos += 0.4 + this.rand() * 0.2
      }
      while (n.vel < until) {
        add(n.vel, velocityFrame(p))
        n.vel += 0.4 + this.rand() * 0.2
      }
      while (n.ident < until) {
        add(n.ident, identFrame(p))
        n.ident += 4.8 + this.rand() * 0.4
      }
      while (n.df11 < until) {
        add(n.df11, allCallFrame(p))
        n.df11 += 0.8 + this.rand() * 0.4
      }
      while (n.df4 < until) {
        add(n.df4, altitudeReply(p))
        n.df4 += 1.5 + this.rand()
      }
      while (n.df5 < until) {
        add(n.df5, identityReply(p))
        n.df5 += 3 + this.rand() * 2
      }
    }
    this.queue.sort((a, b) => a.at - b.at)
  }

  private advance(dt: number): void {
    for (const p of this.planes) {
      const km = (p.speedKt * 1.852 * dt) / 3600
      p.pos = destination(p.pos, p.trackDeg, km)
      p.altFt += (p.climbFpm * dt) / 60
      p.amp = this.amplitude(this.centre, p)
    }
  }

  /** IQ covering the next `ms` of air, interleaved, about -1..1. */
  read(ms: number): Float32Array {
    const n = Math.round((RATE * ms) / 1000)
    const out = new Float32Array(n * 2)
    const start = this.t
    const end = start + n / RATE
    this.schedule(end)

    const env = new Float32Array(n * OVER + 1)
    // a burst that would run past this block waits for the next one.
    while (this.queue.length && this.queue[0].at + BURST_S < end) {
      const b = this.queue.shift()!
      const at = Math.max(0, Math.floor((b.at - start) * RATE * OVER))
      const bits = b.frame.length * 8
      // preamble pulses at 0, 1, 3.5 and 4.5 us, six sub-samples per half bit.
      for (const half of [0, 2, 7, 9]) {
        for (let k = 0; k < 6; k++) {
          const i = at + half * 6 + k
          if (i < env.length) env[i] = Math.max(env[i], b.amp)
        }
      }
      for (let i = 0; i < bits; i++) {
        const one = (b.frame[i >> 3] >> (7 - (i & 7))) & 1
        const half = 16 + i * 2 + (one ? 0 : 1)
        for (let k = 0; k < 6; k++) {
          const s = at + half * 6 + k
          if (s < env.length) env[s] = Math.max(env[s], b.amp)
        }
      }
    }

    const sigma = this.noise
    const table = this.noiseTable()
    let ni = Math.floor(this.rand() * NOISE_LEN)
    for (let j = 0; j < n; j++) {
      let a = 0
      for (let k = 0; k < OVER; k++) a += env[j * OVER + k]
      a /= OVER
      this.phase += this.freq
      if (this.phase > Math.PI) this.phase -= 2 * Math.PI
      out[2 * j] = a * Math.cos(this.phase) + sigma * table[ni]
      out[2 * j + 1] = a * Math.sin(this.phase) + sigma * table[(ni + 1) & (NOISE_LEN - 1)]
      ni = (ni + 2) & (NOISE_LEN - 1)
    }

    this.advance(n / RATE)
    this.t = end
    return out
  }
}

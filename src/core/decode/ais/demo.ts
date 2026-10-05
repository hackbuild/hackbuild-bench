/**
 * A synthetic harbour for demo mode.
 *
 * Builds real AIS bursts, gmsk with frame checks, for a handful of made up
 * stations placed around the receiver, and lays them on the two channels of
 * an IQ window centred at 162.000 MHz with noise under them. The panel runs
 * this through the same receiver a radio feeds, so every row on screen came
 * out of a decode.
 */

import {
  aisBurst,
  encodeAidToNav,
  encodeBaseStation,
  encodeExtendedB,
  encodePositionA,
  encodePositionB,
  encodeStatic,
  encodeStaticB,
} from './synth'
import type { SynthPosition, SynthStatic } from './synth'

export const AIS_DEMO_RATE = 96_000

interface Ship {
  id: SynthStatic
  classB: boolean
  /** Kilometres east and north of the receiver. */
  x: number
  y: number
  sog: number
  cog: number
}

const SHIPS: Array<Omit<Ship, 'x' | 'y'> & { at: [number, number] }> = [
  { id: { mmsi: 366998410, name: 'PACIFIC DAWN', callsign: 'WDK4410', shipType: 70, destination: 'LONG BEACH', imo: 9412234 }, classB: false, at: [-14, 9], sog: 12.4, cog: 118 },
  { id: { mmsi: 366998420, name: 'NORDIC SPIRIT', callsign: 'WDK4420', shipType: 80, destination: 'RICHMOND', imo: 9301876 }, classB: false, at: [8, -18], sog: 0, cog: 0 },
  { id: { mmsi: 366998430, name: 'HARBOR TUG 7', callsign: 'WDK4430', shipType: 52, destination: 'PIER 400' }, classB: false, at: [4, 3], sog: 6.1, cog: 274 },
  { id: { mmsi: 338998440, name: 'LUCKY LADY', callsign: 'WDK4440', shipType: 37, destination: '' }, classB: true, at: [-6, -7], sog: 7.8, cog: 42 },
  { id: { mmsi: 338998450, name: 'SEA WOLF', callsign: 'WDK4450', shipType: 36, destination: '' }, classB: true, at: [11, 12], sog: 4.2, cog: 200 },
]

const BASE_MMSI = 3669984
const AID_MMSI = 993669984

/** Feeds IQ covering the next stretch of the demo, centred at 162.000 MHz. */
export class AisDemoSource {
  readonly sampleRate = AIS_DEMO_RATE
  readonly centerHz = 162_000_000
  private readonly lat0: number
  private readonly lon0: number
  private readonly ships: Ship[]
  private queue: Array<{ at: number; iq: Float32Array }> = []
  private t = 0
  private nextBurst = 0.3
  private turn = 0
  private seed = 7

  constructor(lat: number, lon: number) {
    this.lat0 = lat
    this.lon0 = lon
    this.ships = SHIPS.map((s) => ({ ...s, x: s.at[0], y: s.at[1] }))
  }

  private rnd(): number {
    this.seed = (this.seed * 1103515245 + 12345) % 2147483648
    return this.seed / 2147483648
  }

  private pos(s: Ship): SynthPosition {
    const lat = this.lat0 + s.y / 111.32
    const lon = this.lon0 + s.x / (111.32 * Math.cos((this.lat0 * Math.PI) / 180))
    return {
      mmsi: s.id.mmsi,
      lat,
      lon,
      sog: s.sog,
      cog: s.cog,
      heading: Math.round(s.cog),
      second: Math.floor(this.t) % 60,
    }
  }

  private nextMessage(): Uint8Array {
    const k = this.turn++
    const s = this.ships[k % this.ships.length]
    const p = this.pos(s)
    const round = Math.floor(k / this.ships.length)
    if (k % 17 === 16) return encodeBaseStation(BASE_MMSI, new Date(), this.lat0 + 0.02, this.lon0 - 0.03)
    if (k % 23 === 22) return encodeAidToNav(AID_MMSI, 'DEMO LIGHT 4', 5, this.lat0 - 0.05, this.lon0 + 0.04)
    if (s.classB) {
      if (round % 4 === 1) return encodeStaticB(s.id, 0)
      if (round % 4 === 2) return encodeStaticB(s.id, 1)
      if (round % 9 === 5) return encodeExtendedB(p, s.id)
      return encodePositionB(p)
    }
    if (round % 3 === 1) return encodeStatic(s.id)
    return encodePositionA(p, s.sog === 0 ? 1 : 0)
  }

  private step(dt: number): void {
    for (const s of this.ships) {
      const km = (s.sog * 1.852 * dt) / 3600
      s.x += km * Math.sin((s.cog * Math.PI) / 180)
      s.y += km * Math.cos((s.cog * Math.PI) / 180)
    }
  }

  /** IQ for the next `ms` of air. */
  read(ms: number): Float32Array {
    const rate = this.sampleRate
    const n = Math.round((rate * ms) / 1000)
    const out = new Float32Array(n * 2)
    const start = this.t
    const end = start + n / rate
    while (this.nextBurst < end) {
      const ch = this.rnd() < 0.5 ? -25_000 : 25_000
      const amp = 0.05 + this.rnd() * 0.25
      const burst = aisBurst(this.nextMessage(), rate, ch + (this.rnd() - 0.5) * 400, this.rnd() * 6.28)
      for (let i = 0; i < burst.length; i++) burst[i] *= amp
      this.queue.push({ at: this.nextBurst, iq: burst })
      this.nextBurst += 0.6 + this.rnd() * 1.2
    }
    for (const b of this.queue) {
      const from = Math.round((b.at - start) * rate) * 2
      for (let i = Math.max(0, -from); i < b.iq.length && from + i < out.length; i++) out[from + i] += b.iq[i]
    }
    this.queue = this.queue.filter((b) => b.at + b.iq.length / 2 / rate > end)
    for (let i = 0; i < out.length; i++) out[i] += (this.rnd() - 0.5) * 0.02
    this.step(end - start)
    this.t = end
    return out
  }
}

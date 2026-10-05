/**
 * Synthetic ism traffic for demo mode.
 *
 * Builds real frames, checksums included, for an Acurite tower, a LaCrosse
 * TX141TH-Bv2, a Fine Offset WH24 on FSK and an EV1527 remote, keys them
 * onto a carrier with noise at 250 ksps, and leaves one burst that no
 * protocol claims so the unknown view has something to show. The decoder
 * gets this IQ through the same path as a radio's.
 */

import { crc8, lfsrDigest8Reflect, parity8 } from './checks'

export const DEMO_RATE = 250000
export const DEMO_CENTER_HZ = 433.92e6

type Burst = { kind: 'ook'; train: Array<[number, number]> } | { kind: 'fsk'; bits: number[]; bitUs: number }

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function bitsOf(bytes: number[], count = bytes.length * 8): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) out.push((bytes[i >> 3] >> (7 - (i & 7))) & 1)
  return out
}

function withParity(b: number): number {
  return parity8(b & 0x7f) ? (b & 0x7f) | 0x80 : b & 0x7f
}

function acuriteTower(id: number, tempC: number, humidity: number): Burst {
  const raw = Math.round(tempC * 10) + 1000
  const b = [0xc0 | ((id >> 8) & 0x3f), id & 0xff, withParity(0x44), withParity(humidity), withParity(raw >> 7), withParity(raw & 0x7f)]
  b.push(b.reduce((s, v) => s + v, 0) & 0xff)
  const train: Array<[number, number]> = []
  for (let rep = 0; rep < 3; rep++) {
    for (let i = 0; i < 4; i++) train.push([620, 596])
    for (const bit of bitsOf(b)) train.push(bit ? [408, 204] : [220, 392])
    train[train.length - 1][1] = rep < 2 ? 2192 : 30000
  }
  return { kind: 'ook', train }
}

function lacrosseTh(id: number, channel: number, tempC: number, humidity: number): Burst {
  const raw = Math.round(tempC * 10) + 500
  const b = [id & 0xff, (channel << 4) | ((raw >> 8) & 0x0f), raw & 0xff, humidity]
  b.push(lfsrDigest8Reflect(b, 4, 0x31, 0xf4))
  const train: Array<[number, number]> = []
  for (let rep = 0; rep < 4; rep++) {
    for (let i = 0; i < 4; i++) train.push([833, 833])
    for (const bit of bitsOf(b)) train.push(bit ? [417, 208] : [208, 417])
  }
  train[train.length - 1][1] = 30000
  return { kind: 'ook', train }
}

function remote(id: number, cmd: number): Burst {
  const train: Array<[number, number]> = []
  for (let rep = 0; rep < 4; rep++) {
    for (const bit of bitsOf([id >> 8, id & 0xff, cmd])) train.push(bit ? [1404, 464] : [464, 1404])
    train.push([464, rep < 3 ? 12000 : 30000])
  }
  return { kind: 'ook', train }
}

function wh24(id: number, tempC: number, humidity: number, windMs: number, rainMm: number): Burst {
  const t = Math.round(tempC * 10) + 400
  const w = Math.round((windMs / 1.12) * 8)
  const rain = Math.round(rainMm / 0.3)
  const b = [0x24, id, 214 & 0xff, (((214 >> 8) & 1) << 7) | (((w >> 8) & 1) << 4) | ((t >> 8) & 0x07), t & 0xff, humidity, w & 0xff, 2, rain >> 8, rain & 0xff, 0, 107, 0x03, 0x83, 0xa1]
  b.push(crc8(b, 15, 0x31, 0))
  b.push(b.reduce((s, v) => s + v, 0) & 0xff)
  const bits = [...bitsOf([0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0x2d, 0xd4]), ...bitsOf(b), 1, 0, 1]
  return { kind: 'fsk', bits, bitUs: 58 }
}

function stranger(r: () => number): Burst {
  const train: Array<[number, number]> = []
  for (let i = 0; i < 33; i++) train.push(r() < 0.5 ? [300, 700] : [700, 300])
  train[train.length - 1][1] = 30000
  return { kind: 'ook', train }
}

interface Scheduled {
  start: number
  iq: Float32Array
}

/** A carrier this far off the centre, so the burst does not sit on the dc spike. */
const OFFSET_HZ = 31000
const FSK_DEV_HZ = 38000
const NOISE = 0.035
const AMP = 0.42

export class IsmDemoSource {
  readonly sampleRate = DEMO_RATE
  readonly centerHz = DEMO_CENTER_HZ
  private t = 0
  private next = Math.round(0.4 * DEMO_RATE)
  private turn = 0
  private queue: Scheduled[] = []
  private r = rng(433)
  private temp = 21.4
  private outTemp = 8.2
  private rain = 12.3

  /** IQ for the next stretch of time, interleaved floats like the bus carries. */
  read(ms: number): Float32Array {
    const n = Math.max(1, Math.round((ms / 1000) * this.sampleRate))
    while (this.next < this.t + n) {
      this.queue.push({ start: this.next, iq: this.render(this.nextBurst()) })
      this.next += Math.round((1.6 + this.r() * 1.8) * this.sampleRate)
    }
    const out = new Float32Array(n * 2)
    for (let i = 0; i < n * 2; i++) out[i] = (this.r() + this.r() - 1) * NOISE
    for (const s of this.queue) {
      const from = Math.max(s.start, this.t)
      const to = Math.min(s.start + s.iq.length / 2, this.t + n)
      for (let k = from; k < to; k++) {
        const src = (k - s.start) * 2
        const dst = (k - this.t) * 2
        out[dst] += s.iq[src]
        out[dst + 1] += s.iq[src + 1]
      }
    }
    this.t += n
    this.queue = this.queue.filter((s) => s.start + s.iq.length / 2 > this.t)
    return out
  }

  private nextBurst(): Burst {
    const k = this.turn++ % 6
    this.temp += (this.r() - 0.5) * 0.4
    this.outTemp += (this.r() - 0.5) * 0.6
    if (this.r() < 0.2) this.rain += 0.3
    if (k === 0) return acuriteTower(0x2f15, this.temp, 41 + Math.round(this.r() * 3))
    if (k === 1) return lacrosseTh(0x43, 1, this.outTemp, 72 + Math.round(this.r() * 4))
    if (k === 2) return wh24(162, this.outTemp - 0.6, 69, 1 + this.r() * 3, this.rain)
    if (k === 3) return remote(0x13cd, 0xc0)
    if (k === 4) return stranger(this.r)
    return acuriteTower(0x0b07, this.temp - 2.2, 55)
  }

  private render(b: Burst): Float32Array {
    const us = this.sampleRate / 1e6
    const parts: number[] = []
    const lead = Math.round(300 * us)
    let phase = this.r() * Math.PI * 2
    const push = (len: number, on: boolean, hz: number): void => {
      const step = (2 * Math.PI * hz) / this.sampleRate
      for (let i = 0; i < len; i++) {
        phase += step
        parts.push(on ? AMP * Math.cos(phase) : 0, on ? AMP * Math.sin(phase) : 0)
      }
    }
    push(lead, false, OFFSET_HZ)
    if (b.kind === 'ook') {
      for (const [p, g] of b.train) {
        push(Math.round(p * us), true, OFFSET_HZ)
        push(Math.round(g * us), false, OFFSET_HZ)
      }
    } else {
      // carrier up a little before the first bit, as the sensors do.
      push(Math.round(60 * us), true, OFFSET_HZ - FSK_DEV_HZ)
      let acc = 0
      for (const bit of b.bits) {
        acc += b.bitUs * us
        const len = Math.round(acc)
        acc -= len
        push(len, true, OFFSET_HZ + (bit ? FSK_DEV_HZ : -FSK_DEV_HZ))
      }
      push(Math.round(200 * us), true, OFFSET_HZ - FSK_DEV_HZ)
      push(Math.round(20000 * us), false, OFFSET_HZ)
    }
    return Float32Array.from(parts)
  }
}

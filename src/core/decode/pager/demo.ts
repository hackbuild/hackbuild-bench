/**
 * A synthetic paging channel for demo mode: real POCSAG batches and real
 * FLEX frames, built with the encoders, frequency modulated onto a carrier
 * and handed over as IQ with noise on it. The decoder takes it through the
 * same channel filter and discriminator it uses on the air.
 */

import { pocsagTransmission } from './pocsag'
import type { PocsagPage } from './pocsag'
import { FLEX_MODES, flexFrameSymbols } from './flex'
import type { FlexPage } from './flex'

export const DEMO_IQ_RATE = 256000
/** Where the demo carrier sits from the window centre, so it is off the dc. */
export const DEMO_OFFSET_HZ = 40000

const POCSAG_DEVIATION = 4500
const FLEX_DEVIATION = 4800
const GAP_S = 0.6
const NOISE = 0.05

interface Segment {
  levels: Float32Array
  rates: Float32Array
  deviation: number
}

function pocsagSegment(baud: number, pages: PocsagPage[]): Segment {
  const bits = pocsagTransmission(pages)
  return {
    levels: Float32Array.from(bits, (b) => (b ? -1 : 1)),
    rates: new Float32Array(bits.length).fill(baud),
    deviation: POCSAG_DEVIATION,
  }
}

function flexSegment(code: number, frames: FlexPage[][]): Segment {
  const mode = FLEX_MODES.find((m) => m.code === code) ?? FLEX_MODES[0]
  const map = mode.levels === 2 ? [-1, 0, 0, 1] : [-1, -1 / 3, 1 / 3, 1]
  const levels: number[] = []
  const rates: number[] = []
  frames.forEach((pages, f) => {
    const { symbols, rates: r } = flexFrameSymbols(mode, 0, f, pages)
    for (let k = 0; k < symbols.length; k++) {
      levels.push(map[symbols[k]])
      rates.push(r[k])
    }
  })
  return { levels: Float32Array.from(levels), rates: Float32Array.from(rates), deviation: FLEX_DEVIATION }
}

function demoSegments(): Segment[] {
  return [
    pocsagSegment(1200, [
      { address: 1234567, func: 3, text: 'demo page. this is pocsag at 1200 baud, decoded from iq' },
      { address: 200005, func: 0, text: '555 0143', numeric: true },
    ]),
    flexSegment(0x870c, [
      [
        { capcode: 100001, text: 'flex 1600/2 demo frame, phase a' },
        { capcode: 555000, text: '602-555-0100', numeric: true },
      ],
    ]),
    pocsagSegment(512, [{ address: 42, func: 2, text: 'pocsag 512 is the slow one, a page takes seconds' }]),
    flexSegment(0xdea0, [
      [
        { capcode: 100010, text: 'flex 6400/4 carries four phases', phase: 'A' },
        { capcode: 100011, text: 'this one rode phase b', phase: 'B' },
        { capcode: 100012, text: 'and this one phase c', phase: 'C' },
        { capcode: 100013, text: 'phase d, the last', phase: 'D' },
      ],
    ]),
    pocsagSegment(2400, [{ address: 778899, func: 3, text: 'pocsag 2400, the fastest rate' }]),
  ]
}

/** Serves the demo channel as interleaved IQ at DEMO_IQ_RATE. */
export class PagerDemoSource {
  readonly sampleRate = DEMO_IQ_RATE
  private segments = demoSegments()
  private seg = 0
  private sym = 0
  private within = 0
  private gapLeft = Math.round(GAP_S * DEMO_IQ_RATE)
  private phase = 0
  private smooth = 0
  private seed = 0x2545f491
  private total: number
  private served = 0

  constructor() {
    let n = 0
    for (const s of this.segments) {
      let t = 0
      for (let k = 0; k < s.levels.length; k++) t += DEMO_IQ_RATE / s.rates[k]
      n += t + GAP_S * DEMO_IQ_RATE
    }
    this.total = n + GAP_S * DEMO_IQ_RATE
  }

  get done(): boolean {
    return this.seg >= this.segments.length && this.gapLeft <= 0
  }

  get progress(): number {
    return Math.min(1, this.served / this.total)
  }

  private noise(): number {
    // xorshift, then a sum of four for something close enough to gaussian.
    let acc = 0
    for (let i = 0; i < 4; i++) {
      let x = this.seed
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      this.seed = x >>> 0
      acc += this.seed / 4294967296 - 0.5
    }
    return acc * NOISE * 1.7
  }

  read(ms: number): Float32Array {
    const n = Math.round((DEMO_IQ_RATE * ms) / 1000)
    const out = new Float32Array(n * 2)
    const fs = DEMO_IQ_RATE
    for (let i = 0; i < n; i++) {
      if (this.done) return out.subarray(0, i * 2)
      let level = NaN
      let deviation = 0
      let rate = 1600
      if (this.gapLeft > 0) {
        this.gapLeft--
      } else {
        const s = this.segments[this.seg]
        level = s.levels[this.sym]
        rate = s.rates[this.sym]
        deviation = s.deviation
        this.within += rate / fs
        if (this.within >= 1) {
          this.within -= 1
          if (++this.sym >= s.levels.length) {
            this.sym = 0
            this.seg++
            this.gapLeft = Math.round(GAP_S * fs)
          }
        }
      }
      const on = !Number.isNaN(level)
      // a one pole filter standing in for the transmitter's premodulation filter.
      this.smooth += ((on ? level : 0) - this.smooth) * Math.min(1, (2 * Math.PI * rate * 0.6) / fs)
      this.phase += (2 * Math.PI * (DEMO_OFFSET_HZ + this.smooth * deviation)) / fs
      if (this.phase > Math.PI) this.phase -= 2 * Math.PI
      const a = on ? 0.5 : 0
      out[i * 2] = a * Math.cos(this.phase) + this.noise()
      out[i * 2 + 1] = a * Math.sin(this.phase) + this.noise()
      this.served++
    }
    return out
  }
}

/**
 * Synthetic ACARS on several channels, as IQ, for a bench with no radio.
 *
 * Blocks are built with real parity and crc, keyed as MSK at 2400 baud,
 * amplitude modulated onto each channel's offset, and summed with noise, so
 * the demo exercises the channeliser, the demodulator and the check exactly
 * as live air does. The texts are taken from acarsdec's public test
 * recording and labelled as a demo wherever they appear.
 */

import { ETB, ETX, SOH, STX, SYN, crcUpdate } from './frame'
import { WORK_RATE } from './index'

const BAUD = 2400
const PREKEY_BITS = 128
const AM_DEPTH = 0.6
const NOISE = 0.02
const CARRIER = 0.12

export interface DemoBlock {
  mode: string
  registration: string
  ack: string | null
  label: string
  blockId: string
  /** Downlinks put the message number and flight id first. */
  msgNo?: string
  flight?: string
  text: string
  /** End in ETB, more blocks follow. */
  more?: boolean
}

export const DEMO_BLOCKS: DemoBlock[] = [
  { mode: 'G', registration: '.F-GTAE', ack: null, label: 'H1', blockId: '3', msgNo: 'D65C', flight: 'AF7728', text: '#DFB00000/V206,05,124,183,02,00,00000' },
  { mode: 'E', registration: '.PH-BXR', ack: null, label: '5V', blockId: '4', msgNo: 'S53A', flight: 'KL1681', text: '' },
  { mode: 'E', registration: '.LN-DYY', ack: null, label: 'Q0', blockId: '6', msgNo: 'S47A', flight: 'DY083J', text: '' },
  { mode: '2', registration: '.G-DBCK', ack: 'W', label: '_d', blockId: '0', msgNo: 'S64A', flight: 'BA031T', text: '' },
  { mode: 'x', registration: '.LN-DYY', ack: '5', label: '_d', blockId: 'A', text: '' },
  { mode: '2', registration: '.N824UA', ack: null, label: 'H1', blockId: '0', msgNo: 'D51H', flight: 'UA2315', text: '#DFB8/S82944,2944,3008/HTBLUE,HTGREEN', more: true },
]

function withParity(c: number): number {
  let b = c & 0x7f
  let ones = 0
  for (let i = 0; i < 7; i++) ones += (b >> i) & 1
  if (!(ones & 1)) b |= 0x80
  return b
}

/** The characters between SOH and the crc, parity set, terminator included. */
export function blockBytes(b: DemoBlock): number[] {
  const out: number[] = []
  const put = (s: string): void => {
    for (const ch of s) out.push(withParity(ch.charCodeAt(0)))
  }
  put(b.mode)
  put(b.registration.padStart(7, '.').slice(-7))
  out.push(withParity(b.ack === null ? 0x15 : b.ack.charCodeAt(0)))
  put(b.label[0])
  out.push(withParity(b.label[1] === 'd' ? 0x7f : b.label.charCodeAt(1)))
  put(b.blockId)
  const body = (b.msgNo ?? '') + (b.flight ?? '') + b.text
  if (body) {
    out.push(withParity(STX))
    put(body)
  }
  out.push(b.more ? ETB : ETX)
  return out
}

/** Every bit on air for one block, least significant bit of each character first. */
export function blockBits(b: DemoBlock): number[] {
  const txt = blockBytes(b)
  let crc = 0
  for (const c of txt) crc = crcUpdate(crc, c)
  const bytes = [
    withParity(0x2b),
    withParity(0x2a),
    SYN,
    SYN,
    SOH,
    ...txt,
    crc & 0xff,
    crc >> 8,
    withParity(0x7f),
  ]
  const bits: number[] = new Array(PREKEY_BITS).fill(1)
  for (const c of bytes) for (let i = 0; i < 8; i++) bits.push((c >> i) & 1)
  return bits
}

/**
 * MSK envelope at `rate`. A bit equal to the one before is a full cycle of
 * 2400 Hz and a change is half a cycle of 1200 Hz, so the phase lands on the
 * same point at every bit boundary. The phase is taken from the exact bit
 * time, since rounding a boundary to the nearest sample costs up to 0.6 rad.
 */
export function mskEnvelope(bits: number[], rate: number): Float32Array {
  const tones = new Float32Array(bits.length)
  const start = new Float64Array(bits.length + 1)
  let prev = 1
  for (let k = 0; k < bits.length; k++) {
    tones[k] = bits[k] === prev ? 2400 : 1200
    prev = bits[k]
    start[k + 1] = start[k] + (2 * Math.PI * tones[k]) / BAUD
  }
  const n = Math.floor((bits.length / BAUD) * rate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / rate
    const k = Math.floor(t * BAUD)
    out[i] = 1 + AM_DEPTH * Math.cos(start[k] + 2 * Math.PI * tones[k] * (t - k / BAUD))
  }
  return out
}

interface Burst {
  env: Float32Array
  pos: number
}

/**
 * IQ for a set of channels with bursts dropped in at random. Each burst is
 * held at the work rate across the decimation block, which the boxcar
 * channeliser recovers exactly.
 */
export class AcarsDemoSource {
  readonly sampleRate: number
  readonly centerHz: number
  readonly channelsHz: number[]
  private readonly block: number
  private readonly envRate: number
  private readonly bursts: Array<Burst | null>
  private readonly rot: Array<{ c: number; s: number; dc: number; ds: number }>
  private readonly noise: Float32Array
  private noisePos = 0
  private sub = 0
  private next = 0
  private seq = 0
  private elapsed = 0

  constructor(centerHz: number, sampleRate: number, channelsHz: number[]) {
    this.centerHz = centerHz
    this.sampleRate = sampleRate
    this.channelsHz = channelsHz
    this.block = Math.max(1, Math.round(sampleRate / WORK_RATE))
    this.envRate = sampleRate / this.block
    this.bursts = channelsHz.map(() => null)
    this.rot = channelsHz.map((f) => {
      const w = (2 * Math.PI * (f - centerHz)) / sampleRate
      return { c: 1, s: 0, dc: Math.cos(w), ds: Math.sin(w) }
    })
    this.noise = new Float32Array(1 << 17)
    for (let i = 0; i < this.noise.length; i++) this.noise[i] = (Math.random() - 0.5) * 2 * NOISE
    this.next = 0.5
  }

  /** Interleaved IQ for `seconds` of air. */
  read(seconds: number): Float32Array {
    const n = Math.max(0, Math.round(seconds * this.sampleRate))
    const iq = new Float32Array(n * 2)
    const noise = this.noise
    let np = this.noisePos
    for (let i = 0; i < n * 2; i++) {
      iq[i] = noise[np]
      np = (np + 1) & (noise.length - 1)
    }
    this.noisePos = np

    this.elapsed += seconds
    if (this.elapsed >= this.next) {
      const ch = Math.floor(Math.random() * this.channelsHz.length)
      if (!this.bursts[ch]) {
        const b = DEMO_BLOCKS[this.seq++ % DEMO_BLOCKS.length]
        this.bursts[ch] = { env: mskEnvelope(blockBits(b), this.envRate), pos: 0 }
      }
      this.next = this.elapsed + 0.6 + Math.random() * 1.6
    }

    for (let c = 0; c < this.channelsHz.length; c++) {
      const burst = this.bursts[c]
      if (!burst) continue
      const r = this.rot[c]
      let sub = this.sub
      let pos = burst.pos
      let cr = r.c
      let ci = r.s
      for (let i = 0; i < n && pos < burst.env.length; i++) {
        const a = CARRIER * burst.env[pos]
        iq[2 * i] += a * cr
        iq[2 * i + 1] += a * ci
        const t = cr * r.dc - ci * r.ds
        ci = cr * r.ds + ci * r.dc
        cr = t
        if (++sub === this.block) {
          sub = 0
          pos++
        }
      }
      const g = 1 / Math.hypot(cr, ci)
      r.c = cr * g
      r.s = ci * g
      burst.pos = pos
      if (pos >= burst.env.length) this.bursts[c] = null
    }
    this.sub = (this.sub + n) % this.block
    return iq
  }
}

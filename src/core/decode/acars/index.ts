/**
 * ACARS, several VHF airband channels at once from one IQ window.
 *
 * Each channel is mixed to zero and summed over blocks of samples, which
 * decimates to about 12.5 kHz in one step. The magnitude of each sum is the
 * AM envelope, and that feeds the MSK demodulator and the framer. This is
 * acarsdec's front end: the boxcar is a poor filter, but its nulls fall on
 * the 12.5 kHz grid ACARS channels sit on, and it costs one complex multiply
 * per sample per channel.
 */

import { MskChannel } from './msk'
import { checkBlock, parseBlock } from './frame'
import type { AcarsMessage, RawBlock } from './frame'

export type { AcarsMessage } from './frame'
export { labelName } from './labels'

/** The rate acarsdec demodulates at. */
export const WORK_RATE = 12500
/** Channels keep this far from the window edge and from the dc spike. */
export const GUARD_HZ = 2 * WORK_RATE

export interface ChannelPlan {
  name: string
  channelsHz: number[]
}

export const PLANS: ChannelPlan[] = [
  {
    name: 'north america',
    channelsHz: [129_125_000, 130_025_000, 130_450_000, 131_125_000, 131_550_000],
  },
  {
    name: 'europe',
    channelsHz: [131_525_000, 131_725_000, 131_825_000, 131_850_000],
  },
]

/** Smallest offered rate whose window holds every channel with its guard. */
export function rateFor(channelsHz: number[], rates: number[]): number | null {
  if (!channelsHz.length) return null
  const span = Math.max(...channelsHz) - Math.min(...channelsHz)
  const fit = rates.filter((r) => span <= r - 2 * GUARD_HZ).sort((a, b) => a - b)
  return fit[0] ?? null
}

/**
 * A centre for the window. Every channel stays a guard inside the edges and
 * a guard away from the centre, where the dc spike sits, and no two channels
 * sit mirror to each other, so one cannot land on the other's image.
 * Searched outward from the middle, in 1 kHz steps.
 */
export function centerFor(channelsHz: number[], sampleRate: number): number | null {
  if (!channelsHz.length) return null
  const lo = Math.min(...channelsHz)
  const hi = Math.max(...channelsHz)
  const mid = Math.round((lo + hi) / 2000) * 1000
  const half = sampleRate / 2 - GUARD_HZ
  const ok = (fc: number): boolean => {
    const offs = channelsHz.map((f) => f - fc)
    for (const o of offs) {
      if (Math.abs(o) > half || Math.abs(o) < GUARD_HZ) return false
    }
    for (let i = 0; i < offs.length; i++) {
      for (let j = i + 1; j < offs.length; j++) {
        if (Math.abs(offs[i] + offs[j]) < WORK_RATE) return false
      }
    }
    return true
  }
  for (let d = 0; d <= sampleRate / 2; d += 1000) {
    if (ok(mid + d)) return mid + d
    if (ok(mid - d)) return mid - d
  }
  return null
}

export interface ChannelStats {
  freqHz: number
  messages: number
  /** Blocks framed whose parity or crc could not be repaired. */
  rejected: number
  /** Mean envelope power, dB relative to full scale, smoothed. */
  levelDb: number
}

export interface AcarsDecoderOptions {
  centerHz: number
  sampleRate: number
  channelsHz: number[]
}

class Channelizer {
  readonly freqHz: number
  readonly block: number
  private readonly wre: Float32Array
  private readonly wim: Float32Array
  private pos = 0
  private ar = 0
  private ai = 0
  out: Float32Array

  constructor(freqHz: number, offsetHz: number, sampleRate: number, block: number) {
    this.freqHz = freqHz
    this.block = block
    this.wre = new Float32Array(block)
    this.wim = new Float32Array(block)
    const w = (2 * Math.PI * offsetHz) / sampleRate
    for (let i = 0; i < block; i++) {
      this.wre[i] = Math.cos(w * i) / block
      this.wim[i] = -Math.sin(w * i) / block
    }
    this.out = new Float32Array(0)
  }

  /** Returns how many envelope samples it wrote into `out`. */
  run(iq: Float32Array): number {
    const pairs = iq.length >> 1
    const need = Math.ceil((pairs + this.pos) / this.block)
    if (this.out.length < need) this.out = new Float32Array(need * 2)
    const out = this.out
    const wre = this.wre
    const wim = this.wim
    const block = this.block
    let pos = this.pos
    let ar = this.ar
    let ai = this.ai
    let m = 0
    for (let i = 0, j = 0; i < pairs; i++, j += 2) {
      const xr = iq[j]
      const xi = iq[j + 1]
      const cr = wre[pos]
      const ci = wim[pos]
      ar += xr * cr - xi * ci
      ai += xr * ci + xi * cr
      if (++pos === block) {
        out[m++] = Math.sqrt(ar * ar + ai * ai)
        ar = 0
        ai = 0
        pos = 0
      }
    }
    this.pos = pos
    this.ar = ar
    this.ai = ai
    return m
  }
}

export class AcarsDecoder {
  readonly centerHz: number
  readonly sampleRate: number
  /** The rate each channel's envelope runs at, sampleRate over the block. */
  readonly workRate: number
  readonly stats: ChannelStats[]
  onMessage: ((m: AcarsMessage) => void) | null = null

  private readonly chans: Channelizer[]
  private readonly msk: MskChannel[]

  constructor(opts: AcarsDecoderOptions) {
    this.centerHz = opts.centerHz
    this.sampleRate = opts.sampleRate
    const block = Math.max(1, Math.round(opts.sampleRate / WORK_RATE))
    this.workRate = opts.sampleRate / block
    this.chans = opts.channelsHz.map(
      (f) => new Channelizer(f, f - opts.centerHz, opts.sampleRate, block),
    )
    this.stats = opts.channelsHz.map((f) => ({ freqHz: f, messages: 0, rejected: 0, levelDb: -120 }))
    this.msk = opts.channelsHz.map((f, i) => {
      const m = new MskChannel(this.workRate)
      m.onBlock = (b) => this.block(i, f, b)
      return m
    })
  }

  feed(iq: Float32Array): void {
    for (let c = 0; c < this.chans.length; c++) {
      const ch = this.chans[c]
      const n = ch.run(iq)
      if (!n) continue
      let p = 0
      for (let i = 0; i < n; i++) p += ch.out[i] * ch.out[i]
      const db = 10 * Math.log10(p / n + 1e-20)
      const st = this.stats[c]
      st.levelDb = st.levelDb <= -119 ? db : st.levelDb * 0.9 + db * 0.1
      this.msk[c].process(ch.out, n)
    }
  }

  private block(c: number, freqHz: number, raw: RawBlock): void {
    const res = checkBlock(raw)
    const st = this.stats[c]
    if (!res.ok) {
      st.rejected++
      return
    }
    st.messages++
    const msg = parseBlock(res.bytes, {
      channel: c,
      freqHz,
      atSec: raw.at / this.workRate,
      levelDb: raw.levelDb,
      corrected: res.corrected,
    })
    this.onMessage?.(msg)
  }
}

/** Runs the MSK stage and the framer on an envelope that is already AM demodulated. */
export class AcarsEnvelopeDecoder {
  onMessage: ((m: AcarsMessage) => void) | null = null
  rejected = 0
  private readonly msk: MskChannel
  private readonly channel: number
  private readonly freqHz: number

  constructor(rate: number, channel = 0, freqHz = 0) {
    this.msk = new MskChannel(rate)
    this.channel = channel
    this.freqHz = freqHz
    this.msk.onBlock = (raw) => {
      const res = checkBlock(raw)
      if (!res.ok) {
        this.rejected++
        return
      }
      this.onMessage?.(
        parseBlock(res.bytes, {
          channel: this.channel,
          freqHz: this.freqHz,
          atSec: raw.at / rate,
          levelDb: raw.levelDb,
          corrected: res.corrected,
        }),
      )
    }
  }

  feed(env: Float32Array): void {
    this.msk.process(env)
  }
}

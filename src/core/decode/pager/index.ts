/**
 * The pager receiver: one narrowband channel out of the radio's IQ, a
 * frequency discriminator, and symbol slicers for every POCSAG rate and for
 * FLEX running side by side on the same audio. Whichever finds its sync
 * word decodes, so the rate and the polarity never need setting.
 */

import { SymbolSlicer } from './fsk'
import { FlexFramer } from './flex'
import { POCSAG_BAUDS, PocsagFramer } from './pocsag'
import type { PagerMessage } from './types'

export type { PagerMessage, PagerKind, PagerProto } from './types'
export { FLEX_MODES } from './flex'
export { POCSAG_BAUDS } from './pocsag'

/** The rate the channel is cut down to before the discriminator. */
const CHANNEL_RATE_TARGET = 64000
/**
 * Half the channel kept. Paging deviates 4.8 kHz at most, and the rest is
 * room for a crystal that is tens of ppm out at 930 MHz.
 */
const CHANNEL_HALF_WIDTH = 14000
const FIR_TAPS = 47
/** Time constant of the IQ dc removal. Long enough to leave a 2 Hz wide notch. */
const DC_SECONDS = 0.1

function lowPassTaps(cutoff: number, rate: number, taps: number): Float32Array {
  const h = new Float32Array(taps)
  const fc = cutoff / rate
  const mid = (taps - 1) / 2
  let sum = 0
  for (let i = 0; i < taps; i++) {
    const x = i - mid
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1))
    h[i] = sinc * w
    sum += h[i]
  }
  for (let i = 0; i < taps; i++) h[i] /= sum
  return h
}

/**
 * Removes the dc, mixes the channel to zero and decimates by `factor` in one
 * pass. The decimating filter is three boxcars in a row, so a strong signal
 * elsewhere in the window folds back onto the channel three times as far
 * down in dB as a single boxcar would leave it.
 */
class MixDecimator {
  private readonly factor: number
  private readonly taps: Float32Array
  private readonly hist: Float32Array
  private at = 0
  private phaseCount = 0
  private cos = 1
  private sin = 0
  private readonly stepCos: number
  private readonly stepSin: number
  private since = 0
  private dcI = 0
  private dcQ = 0
  private readonly dcPole: number

  constructor(factor: number, offsetHz: number, sampleRate: number) {
    this.factor = factor
    let k = new Float32Array(factor).fill(1)
    for (let stage = 1; stage < 3; stage++) {
      const next = new Float32Array(k.length + factor - 1)
      for (let i = 0; i < k.length; i++) for (let j = 0; j < factor; j++) next[i + j] += k[i]
      k = next
    }
    let sum = 0
    for (const v of k) sum += v
    this.taps = k.map((v) => v / sum)
    this.hist = new Float32Array(this.taps.length * 4)
    const w = (-2 * Math.PI * offsetHz) / sampleRate
    this.stepCos = Math.cos(w)
    this.stepSin = Math.sin(w)
    this.dcPole = 1 - Math.exp(-1 / (DC_SECONDS * sampleRate))
  }

  process(iq: Float32Array): Float32Array {
    const n = this.taps.length
    const hist = this.hist
    const taps = this.taps
    const out = new Float32Array(Math.ceil(iq.length / 2 / this.factor) * 2 + 2)
    let o = 0
    let c = this.cos
    let s = this.sin
    let di = this.dcI
    let dq = this.dcQ
    const a = this.dcPole
    for (let k = 0; k < iq.length; k += 2) {
      // a zero if tuner leaves a carrier at the window centre, and a channel
      // near it would otherwise have the discriminator follow the spike.
      di += (iq[k] - di) * a
      dq += (iq[k + 1] - dq) * a
      const ri = iq[k] - di
      const rq = iq[k + 1] - dq
      const mi = ri * c - rq * s
      const mq = ri * s + rq * c
      const nc = c * this.stepCos - s * this.stepSin
      s = c * this.stepSin + s * this.stepCos
      c = nc
      if (++this.since >= 1024) {
        this.since = 0
        const m = Math.hypot(c, s) || 1
        c /= m
        s /= m
      }
      // the history is written twice, a length apart, so a read never wraps.
      hist[this.at * 2] = hist[(this.at + n) * 2] = mi
      hist[this.at * 2 + 1] = hist[(this.at + n) * 2 + 1] = mq
      this.at = (this.at + 1) % n
      if (++this.phaseCount < this.factor) continue
      this.phaseCount = 0
      let si = 0
      let sq = 0
      for (let t = 0; t < n; t++) {
        const idx = (this.at + t) * 2
        si += hist[idx] * taps[t]
        sq += hist[idx + 1] * taps[t]
      }
      out[o++] = si
      out[o++] = sq
    }
    this.cos = c
    this.sin = s
    this.dcI = di
    this.dcQ = dq
    return out.subarray(0, o)
  }
}

/** Low pass then keep every second sample, on interleaved IQ. */
class HalfBand {
  private readonly taps: Float32Array
  private readonly hist: Float32Array
  private at = 0
  private odd = false

  constructor(taps: Float32Array) {
    this.taps = taps
    this.hist = new Float32Array(taps.length * 2 * 2)
  }

  process(iq: Float32Array): Float32Array {
    const n = this.taps.length
    const hist = this.hist
    const out = new Float32Array(Math.ceil(iq.length / 4) * 2 + 2)
    let o = 0
    for (let k = 0; k < iq.length; k += 2) {
      // the history is written twice, a length apart, so a read never wraps.
      hist[this.at * 2] = hist[(this.at + n) * 2] = iq[k]
      hist[this.at * 2 + 1] = hist[(this.at + n) * 2 + 1] = iq[k + 1]
      this.at = (this.at + 1) % n
      this.odd = !this.odd
      if (this.odd) continue
      let si = 0
      let sq = 0
      const base = this.at
      for (let t = 0; t < n; t++) {
        const idx = (base + t) * 2
        si += hist[idx] * this.taps[t]
        sq += hist[idx + 1] * this.taps[t]
      }
      out[o++] = si
      out[o++] = sq
    }
    return out.subarray(0, o)
  }
}

export interface PagerLevels {
  /** Average power in the channel, dBFS. */
  channelDb: number
  /** How far the carrier sits from where the channel was cut, in Hz. */
  offsetHz: number
  /** Measured deviation in Hz, half the span of the outer tones. */
  deviationHz: number
}

export interface PagerDecoderOptions {
  pocsag?: boolean
  flex?: boolean
}

interface Chain {
  rate: number
  pocsag: Array<{ slicer: SymbolSlicer; framer: PocsagFramer }>
  flex: { slicer: SymbolSlicer; framer: FlexFramer } | null
}

export class PagerDecoder {
  onMessage: ((m: PagerMessage) => void) | null = null

  private readonly useFlex: boolean
  private readonly usePocsag: boolean
  private chain: Chain | null = null
  private down: MixDecimator | null = null
  private half: HalfBand | null = null
  private iqRate = 0
  private offset = 0
  private lastI = 0
  private lastQ = 0
  private channelPow = 0
  private discRate = 0

  constructor(opts: PagerDecoderOptions = {}) {
    this.usePocsag = opts.pocsag ?? true
    this.useFlex = opts.flex ?? true
  }

  /** Signal readouts for the panel. Deviation and offset read 0 until a slicer has seen symbols. */
  levels(): PagerLevels {
    const c = this.chain
    let ref: SymbolSlicer | null = null
    if (c) {
      const busy = c.flex?.framer.inFrame ? c.flex.slicer : c.pocsag.find((p) => p.framer.locked)?.slicer
      ref = busy ?? c.flex?.slicer ?? c.pocsag[0]?.slicer ?? null
    }
    return {
      channelDb: 10 * Math.log10(this.channelPow + 1e-12),
      offsetHz: ref && this.discRate ? ref.center : 0,
      deviationHz: ref && this.discRate ? ref.span : 0,
    }
  }

  /** FLEX frames whose frame information word decoded. */
  get flexFrames(): number {
    return this.chain?.flex?.framer.stats.frames ?? 0
  }

  /** True while any decoder holds sync, so a panel can show it is mid page. */
  get busy(): boolean {
    const c = this.chain
    if (!c) return false
    return Boolean(c.flex?.framer.inFrame) || c.pocsag.some((p) => p.framer.locked)
  }

  reset(): void {
    this.chain = null
    this.half = null
    this.iqRate = 0
  }

  /**
   * Interleaved IQ at the radio's rate. `offsetHz` is where the channel sits
   * from the centre of the window.
   */
  feedIq(iq: Float32Array, sampleRate: number, offsetHz = 0): void {
    if (sampleRate !== this.iqRate || offsetHz !== this.offset) {
      this.iqRate = sampleRate
      this.offset = offsetHz
      const factor = Math.max(1, Math.round(sampleRate / CHANNEL_RATE_TARGET))
      this.down = new MixDecimator(factor, offsetHz, sampleRate)
      const mid = sampleRate / factor
      this.half = new HalfBand(lowPassTaps(CHANNEL_HALF_WIDTH, mid, FIR_TAPS))
      this.discRate = mid / 2
    }
    const base = this.down ? this.down.process(iq) : iq
    const ch = this.half ? this.half.process(base) : base
    const audio = new Float32Array(ch.length / 2)
    const k = this.discRate / (2 * Math.PI)
    let pow = 0
    for (let i = 0, o = 0; i < ch.length; i += 2, o++) {
      const ri = ch[i]
      const rq = ch[i + 1]
      pow += ri * ri + rq * rq
      const di = ri * this.lastI + rq * this.lastQ
      const dq = rq * this.lastI - ri * this.lastQ
      audio[o] = Math.atan2(dq, di) * k
      this.lastI = ri
      this.lastQ = rq
    }
    if (audio.length) this.channelPow = this.channelPow * 0.7 + (pow / audio.length) * 0.3
    this.run(audio, this.discRate)
  }

  /** FM demodulated audio, as a receiver or a recording hands it over. */
  feedAudio(samples: Float32Array, sampleRate: number): void {
    this.discRate = 0
    this.run(samples, sampleRate)
  }

  /** Ends open pages, for a stream that stopped. */
  flush(): void {
    for (const p of this.chain?.pocsag ?? []) p.framer.flush()
  }

  private build(rate: number): Chain {
    const emit = (m: PagerMessage) => this.onMessage?.(m)
    const pocsag = this.usePocsag
      ? POCSAG_BAUDS.map((baud) => {
          const framer = new PocsagFramer(baud)
          framer.onMessage = emit
          return { slicer: new SymbolSlicer(rate, baud), framer }
        })
      : []
    let flex: Chain['flex'] = null
    if (this.useFlex) {
      const framer = new FlexFramer()
      framer.onMessage = emit
      flex = { slicer: new SymbolSlicer(rate, 1600, 3200), framer }
    }
    return { rate, pocsag, flex }
  }

  private run(audio: Float32Array, rate: number): void {
    if (!this.chain || this.chain.rate !== rate) this.chain = this.build(rate)
    const c = this.chain
    for (const p of c.pocsag) {
      const framer = p.framer
      const slicer = p.slicer
      slicer.process(audio, (sym) => {
        framer.push(sym > 1 ? 0 : 1)
        slicer.locked = framer.locked
      })
    }
    const f = c.flex
    if (f) {
      const { slicer, framer } = f
      slicer.process(audio, (sym, value) => {
        framer.push(sym, slicer.span > 0 ? value / slicer.span : 0)
        slicer.rate = framer.symbolRate
        slicer.levels = framer.levels
        slicer.hold = framer.inFrame
      })
    }
  }
}

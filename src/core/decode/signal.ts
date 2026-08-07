/**
 * The front end every rx decoder shares.
 *
 * Input is real audio at whatever rate the receiver hands over. Each block
 * reconfigures itself when that rate changes, so a panel can hand samples
 * straight from an audio tap without knowing where they came from.
 */

import { LowPass } from '@/core/dsp/demod'

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x
}

export function clamp255(x: number): number {
  return x < 0 ? 0 : x > 255 ? 255 : x
}

/** Removes the dc a demodulator leaves behind, which biases every slicer. */
export class DcBlock {
  private lastIn = 0
  private lastOut = 0
  private readonly pole: number

  constructor(pole = 0.995) {
    this.pole = pole
  }

  process(x: Float32Array): Float32Array {
    const out = new Float32Array(x.length)
    for (let i = 0; i < x.length; i++) {
      const y = x[i] - this.lastIn + this.pole * this.lastOut
      this.lastIn = x[i]
      this.lastOut = y
      out[i] = y
    }
    return out
  }

  reset(): void {
    this.lastIn = 0
    this.lastOut = 0
  }
}

/**
 * Moving average. The nulls at multiples of rate/length are the reason this
 * is here rather than another one pole: the am detector needs the carrier
 * ripple gone, not attenuated.
 */
export class Boxcar {
  private buf: Float32Array
  private pos = 0
  private sum = 0

  constructor(length: number) {
    this.buf = new Float32Array(Math.max(1, Math.round(length)))
  }

  get length(): number {
    return this.buf.length
  }

  step(x: number): number {
    this.sum += x - this.buf[this.pos]
    this.buf[this.pos] = x
    this.pos = (this.pos + 1) % this.buf.length
    return this.sum / this.buf.length
  }

  reset(): void {
    this.buf.fill(0)
    this.sum = 0
    this.pos = 0
  }
}

/**
 * Instantaneous frequency in Hz, one estimate per input sample.
 *
 * The signal is mixed down to baseband around centerHz, low passed, and the
 * phase step between neighbouring samples is read off. Estimates are noisy
 * sample to sample and are meant to be averaged over a symbol or a pixel.
 */
export class FreqDiscriminator {
  private readonly centerHz: number
  private readonly cutoffHz: number
  private readonly poles: number
  private sampleRate = 0
  private phase = 0
  private lastI = 0
  private lastQ = 0
  private lpI: LowPass[] = []
  private lpQ: LowPass[] = []
  private scale = 0

  constructor(centerHz: number, cutoffHz: number, poles = 3) {
    this.centerHz = centerHz
    this.cutoffHz = cutoffHz
    this.poles = Math.max(1, poles)
  }

  configure(sampleRate: number): void {
    this.sampleRate = sampleRate
    this.scale = sampleRate / (2 * Math.PI)
    this.lpI = []
    this.lpQ = []
    for (let i = 0; i < this.poles; i++) {
      this.lpI.push(new LowPass(this.cutoffHz, sampleRate))
      this.lpQ.push(new LowPass(this.cutoffHz, sampleRate))
    }
    this.phase = 0
    this.lastI = 0
    this.lastQ = 0
  }

  reset(): void {
    if (this.sampleRate) this.configure(this.sampleRate)
  }

  process(x: Float32Array, sampleRate: number): Float32Array {
    if (sampleRate !== this.sampleRate) this.configure(sampleRate)
    const n = x.length
    const i = new Float32Array(n)
    const q = new Float32Array(n)
    const step = (-2 * Math.PI * this.centerHz) / sampleRate

    for (let k = 0; k < n; k++) {
      i[k] = x[k] * Math.cos(this.phase)
      q[k] = x[k] * Math.sin(this.phase)
      this.phase += step
      if (this.phase < -Math.PI) this.phase += 2 * Math.PI
    }
    for (const lp of this.lpI) lp.process(i)
    for (const lp of this.lpQ) lp.process(q)

    const out = new Float32Array(n)
    for (let k = 0; k < n; k++) {
      const di = i[k] * this.lastI + q[k] * this.lastQ
      const dq = q[k] * this.lastI - i[k] * this.lastQ
      out[k] = this.centerHz + Math.atan2(dq, di) * this.scale
      this.lastI = i[k]
      this.lastQ = q[k]
    }
    return out
  }
}

/**
 * Envelope of an amplitude modulated subcarrier.
 *
 * The boxcar length is picked so its first null lands on twice the carrier,
 * which is where the detection product puts its ripple.
 */
export class AmEnvelope {
  private readonly carrierHz: number
  private readonly cutoffHz: number
  private sampleRate = 0
  private phase = 0
  private boxI = new Boxcar(1)
  private boxQ = new Boxcar(1)
  private lpI: LowPass | null = null
  private lpQ: LowPass | null = null

  constructor(carrierHz: number, cutoffHz: number) {
    this.carrierHz = carrierHz
    this.cutoffHz = cutoffHz
  }

  configure(sampleRate: number): void {
    this.sampleRate = sampleRate
    const len = Math.max(2, Math.round(sampleRate / (2 * this.carrierHz)))
    this.boxI = new Boxcar(len)
    this.boxQ = new Boxcar(len)
    this.lpI = new LowPass(this.cutoffHz, sampleRate)
    this.lpQ = new LowPass(this.cutoffHz, sampleRate)
    this.phase = 0
  }

  reset(): void {
    if (this.sampleRate) this.configure(this.sampleRate)
  }

  process(x: Float32Array, sampleRate: number): Float32Array {
    if (sampleRate !== this.sampleRate) this.configure(sampleRate)
    const n = x.length
    const i = new Float32Array(n)
    const q = new Float32Array(n)
    const step = (-2 * Math.PI * this.carrierHz) / sampleRate

    for (let k = 0; k < n; k++) {
      i[k] = this.boxI.step(x[k] * Math.cos(this.phase))
      q[k] = this.boxQ.step(x[k] * Math.sin(this.phase))
      this.phase += step
      if (this.phase < -Math.PI) this.phase += 2 * Math.PI
    }
    this.lpI?.process(i)
    this.lpQ?.process(q)

    const out = new Float32Array(n)
    for (let k = 0; k < n; k++) out[k] = 2 * Math.hypot(i[k], q[k])
    return out
  }
}

/**
 * Sliding correlation against two tones, one output per input sample.
 *
 * Positive means the mark tone is stronger. The window is normally one symbol
 * long, which is what makes this a matched filter for binary fsk.
 */
export class ToneCorrelator {
  private readonly n: number
  private readonly mc: Float32Array
  private readonly ms: Float32Array
  private readonly sc: Float32Array
  private readonly ss: Float32Array
  private ring: Float32Array
  private pos = 0

  constructor(markHz: number, spaceHz: number, sampleRate: number, windowLen: number) {
    this.n = Math.max(4, Math.round(windowLen))
    this.mc = new Float32Array(this.n)
    this.ms = new Float32Array(this.n)
    this.sc = new Float32Array(this.n)
    this.ss = new Float32Array(this.n)
    for (let k = 0; k < this.n; k++) {
      const a = (2 * Math.PI * markHz * k) / sampleRate
      const b = (2 * Math.PI * spaceHz * k) / sampleRate
      this.mc[k] = Math.cos(a)
      this.ms[k] = Math.sin(a)
      this.sc[k] = Math.cos(b)
      this.ss[k] = Math.sin(b)
    }
    this.ring = new Float32Array(this.n)
  }

  process(x: Float32Array): Float32Array {
    const out = new Float32Array(x.length)
    const n = this.n
    for (let s = 0; s < x.length; s++) {
      this.ring[this.pos] = x[s]
      this.pos = (this.pos + 1) % n
      let mi = 0
      let mq = 0
      let si = 0
      let sq = 0
      for (let k = 0; k < n; k++) {
        const v = this.ring[(this.pos + k) % n]
        mi += v * this.mc[k]
        mq += v * this.ms[k]
        si += v * this.sc[k]
        sq += v * this.ss[k]
      }
      out[s] = Math.hypot(mi, mq) - Math.hypot(si, sq)
    }
    return out
  }

  reset(): void {
    this.ring = new Float32Array(this.n)
    this.pos = 0
  }
}

/**
 * Linear resampler that consumes every input sample.
 *
 * The rate change is exact over a long capture, which matters when a weather
 * satellite pass runs for ten minutes and a lost sample per block would walk
 * the image sideways.
 */
export class LinearResampler {
  private prev = 0
  private frac = 0
  private step: number

  constructor(step: number) {
    this.step = Math.max(1e-6, step)
  }

  setStep(step: number): void {
    this.step = Math.max(1e-6, step)
  }

  reset(): void {
    this.prev = 0
    this.frac = 0
  }

  process(x: Float32Array): Float32Array {
    const n = x.length
    if (n === 0) return x
    const out = new Float32Array(Math.ceil(n / this.step) + 2)
    let o = 0
    let u = this.frac
    while (u <= n - 1) {
      const i = Math.floor(u)
      const f = u - i
      const a = i < 0 ? this.prev : x[i]
      const b = i + 1 < n ? x[i + 1] : a
      out[o++] = a + (b - a) * f
      u += this.step
    }
    this.frac = u - n
    this.prev = x[n - 1]
    return out.subarray(0, o)
  }
}

/**
 * A growable window over a sample stream addressed by absolute index.
 *
 * Decoders that need to look backwards, such as an sstv line that has to find
 * its sync pulse a few milliseconds either side of where it expected one, hold
 * their history here and drop the part they are past.
 */
export class SampleTrace {
  private buf: Float32Array
  private len = 0
  private origin = 0

  constructor(capacity = 1 << 16) {
    this.buf = new Float32Array(Math.max(1024, capacity))
  }

  get base(): number {
    return this.origin
  }

  get end(): number {
    return this.origin + this.len
  }

  push(x: Float32Array): void {
    if (this.len + x.length > this.buf.length) {
      let cap = this.buf.length
      while (cap < this.len + x.length) cap *= 2
      const next = new Float32Array(cap)
      next.set(this.buf.subarray(0, this.len))
      this.buf = next
    }
    this.buf.set(x, this.len)
    this.len += x.length
  }

  at(abs: number): number {
    const i = Math.round(abs) - this.origin
    return i >= 0 && i < this.len ? this.buf[i] : 0
  }

  /** Mean over the absolute half open range, 0 when nothing lands in it. */
  mean(a: number, b: number): number {
    const from = Math.max(Math.round(a) - this.origin, 0)
    const to = Math.min(Math.round(b) - this.origin, this.len)
    let sum = 0
    let count = 0
    for (let i = from; i < to; i++) {
      sum += this.buf[i]
      count++
    }
    return count ? sum / count : 0
  }

  drop(upTo: number): void {
    const cut = Math.min(Math.max(Math.round(upTo) - this.origin, 0), this.len)
    if (cut <= 0) return
    this.buf.copyWithin(0, cut, this.len)
    this.len -= cut
    this.origin += cut
  }

  clear(): void {
    this.len = 0
    this.origin = 0
  }
}

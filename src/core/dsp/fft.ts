/**
 * Radix-2 FFT with precomputed twiddles and a reusable scratch buffer, plus
 * the spectrum helpers the waterfall and spectrum instruments consume.
 *
 * Runs in place on interleaved complex input so an IQ chunk can be transformed
 * without another allocation per frame.
 */

export class Fft {
  readonly size: number
  private cos: Float32Array
  private sin: Float32Array
  private rev: Uint32Array

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`fft size must be a power of two, got ${size}`)
    }
    this.size = size
    this.cos = new Float32Array(size / 2)
    this.sin = new Float32Array(size / 2)
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size)
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size)
    }
    this.rev = new Uint32Array(size)
    const bits = Math.log2(size)
    for (let i = 0; i < size; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
  }

  /** In place transform. re and im are each `size` long. */
  transform(re: Float32Array, im: Float32Array): void {
    const n = this.size

    for (let i = 0; i < n; i++) {
      const j = this.rev[i]
      if (j > i) {
        let t = re[i]
        re[i] = re[j]
        re[j] = t
        t = im[i]
        im[i] = im[j]
        im[j] = t
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1
      const step = n / len
      for (let i = 0; i < n; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = this.cos[k]
          const s = this.sin[k]
          const a = i + j
          const b = a + half
          const tre = re[b] * c - im[b] * s
          const tim = re[b] * s + im[b] * c
          re[b] = re[a] - tre
          im[b] = im[a] - tim
          re[a] += tre
          im[a] += tim
        }
      }
    }
  }
}

export type WindowKind = 'hann' | 'hamming' | 'blackman' | 'rect'

export function makeWindow(size: number, kind: WindowKind): Float32Array {
  const w = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    const x = (2 * Math.PI * i) / (size - 1)
    switch (kind) {
      case 'hann':
        w[i] = 0.5 - 0.5 * Math.cos(x)
        break
      case 'hamming':
        w[i] = 0.54 - 0.46 * Math.cos(x)
        break
      case 'blackman':
        w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x)
        break
      case 'rect':
        w[i] = 1
        break
    }
  }
  return w
}

/**
 * Turns interleaved IQ into a dB spectrum, fftshifted so DC sits in the middle
 * the way every spectrum display expects.
 */
export class SpectrumAnalyzer {
  private fft: Fft
  private win: Float32Array
  private re: Float32Array
  private im: Float32Array
  private out: Float32Array
  readonly size: number

  constructor(size = 2048, window: WindowKind = 'hann') {
    this.size = size
    this.fft = new Fft(size)
    this.win = makeWindow(size, window)
    this.re = new Float32Array(size)
    this.im = new Float32Array(size)
    this.out = new Float32Array(size)
  }

  setWindow(kind: WindowKind): void {
    this.win = makeWindow(this.size, kind)
  }

  /**
   * `iq` is interleaved I,Q normalised to roughly -1..1. Returns a view of an
   * internal buffer that is overwritten on the next call, so copy it if you
   * are keeping it.
   */
  process(iq: Float32Array, offset = 0): Float32Array {
    const n = this.size
    for (let i = 0; i < n; i++) {
      const w = this.win[i]
      const k = offset + i * 2
      this.re[i] = (iq[k] ?? 0) * w
      this.im[i] = (iq[k + 1] ?? 0) * w
    }
    this.fft.transform(this.re, this.im)

    const half = n >> 1
    const scale = 1 / n
    for (let i = 0; i < n; i++) {
      // fftshift: the second half of the transform is the negative frequencies
      // and belongs on the left of the display.
      const src = (i + half) % n
      const mag = Math.hypot(this.re[src], this.im[src]) * scale
      this.out[i] = 20 * Math.log10(mag + 1e-12)
    }
    return this.out
  }
}

/** Exponential smoothing across frames, so the trace is readable at 60 fps. */
export function smoothInto(
  target: Float32Array,
  frame: Float32Array,
  alpha: number,
): Float32Array {
  if (target.length !== frame.length) {
    target = new Float32Array(frame.length).fill(-120)
  }
  for (let i = 0; i < frame.length; i++) {
    target[i] = target[i] * (1 - alpha) + frame[i] * alpha
  }
  return target
}

/** Peak hold, decaying slowly so a burst stays visible after it ends. */
export function peakHoldInto(target: Float32Array, frame: Float32Array, decayDb: number): void {
  for (let i = 0; i < frame.length; i++) {
    const decayed = target[i] - decayDb
    target[i] = frame[i] > decayed ? frame[i] : decayed
  }
}

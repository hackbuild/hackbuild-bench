/**
 * Finds radiosondes in the 400 to 406 MHz band.
 *
 * The band is wider than an rtl-sdr's window, so the radio steps across it
 * and each window's spectrum is folded into one picture with a peak hold.
 * An RS41 keys up for about half of every second, so a window is watched
 * for well over a second before moving on. A sonde shows as a lump about
 * 10 kHz wide; the strongest lump well clear of the noise floor wins, and
 * its frequency is the power weighted centre of the lump, which falls
 * between its two tones.
 */

import { Fft } from '@/core/dsp/fft'

export const SONDE_LOW_HZ = 400_000_000
export const SONDE_HIGH_HZ = 406_000_000
/** Rate the scan asks for, and the share of each window it trusts. */
export const SCAN_RATE = 2_048_000
const KEEP = 0.75
const FFT_SIZE = 4096
const GRID_HZ = SCAN_RATE / FFT_SIZE
/** The window centre, where a zero if tuner leaves its dc spike, is not trusted. */
const DC_GUARD_HZ = 15_000
/** Half the width of a sonde's lump. */
const LUMP_HZ = 6_000
/** How far over the floor a lump must stand. */
const MIN_SNR_DB = 8

/** The part of a window the scan trusts, low and high edge in Hz. */
export function keptSpan(centerHz: number, rate: number): [number, number] {
  const half = (rate * KEEP) / 2
  return [centerHz - half, centerHz + half]
}

/**
 * Window centres across the band. Each window keeps its middle three
 * quarters less the dc guard, so windows overlap by half a window: every
 * centre, and a whole lump either side of it, falls inside a neighbour's
 * kept part.
 */
export function scanPlan(rate = SCAN_RATE): number[] {
  const half = (rate * KEEP) / 2
  const step = half - DC_GUARD_HZ - LUMP_HZ
  const out: number[] = []
  let c = SONDE_LOW_HZ + half - DC_GUARD_HZ - LUMP_HZ
  out.push(Math.round(c))
  while (c + half < SONDE_HIGH_HZ) {
    c += step
    out.push(Math.round(c))
  }
  return out
}

export interface SondeCandidate {
  hz: number
  /** dB over the median of the band. */
  snrDb: number
}

export class SondeScanner {
  private readonly fft = new Fft(FFT_SIZE)
  private readonly re = new Float32Array(FFT_SIZE)
  private readonly im = new Float32Array(FFT_SIZE)
  private readonly win = new Float32Array(FFT_SIZE)
  /** Peak power per grid step across the band, linear. */
  readonly hold: Float32Array
  private fill = 0
  private lastCenter = 0
  private lastRate = 0
  private seen: Uint8Array
  /**
   * Skip the window centre. A recording has no live dc spike to hide, and a
   * capture centred on a sonde holds it right there, so the panel turns this
   * off for one.
   */
  dcGuard = true

  constructor() {
    const n = Math.ceil((SONDE_HIGH_HZ - SONDE_LOW_HZ) / GRID_HZ)
    this.hold = new Float32Array(n)
    this.seen = new Uint8Array(n)
    for (let i = 0; i < FFT_SIZE; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE)
  }

  reset(): void {
    this.hold.fill(0)
    this.seen.fill(0)
    this.fill = 0
  }

  /** Share of the band that has been looked at, 0 to 1. */
  get coverage(): number {
    let k = 0
    for (let i = 0; i < this.seen.length; i++) k += this.seen[i]
    return k / this.seen.length
  }

  feed(iq: Float32Array, centerHz: number, sampleRate: number): void {
    // a transform half filled in the last window would land its signal at this window's offsets.
    if (centerHz !== this.lastCenter || sampleRate !== this.lastRate) {
      this.fill = 0
      this.lastCenter = centerHz
      this.lastRate = sampleRate
    }
    for (let n = 0; n + 1 < iq.length; n += 2) {
      this.re[this.fill] = iq[n] * this.win[this.fill]
      this.im[this.fill] = iq[n + 1] * this.win[this.fill]
      if (++this.fill === FFT_SIZE) {
        this.fill = 0
        this.fold(centerHz, sampleRate)
      }
    }
  }

  private fold(centerHz: number, rate: number): void {
    this.fft.transform(this.re, this.im)
    const binHz = rate / FFT_SIZE
    const half = (rate * KEEP) / 2
    for (let k = 0; k < FFT_SIZE; k++) {
      const off = (k < FFT_SIZE / 2 ? k : k - FFT_SIZE) * binHz
      if (Math.abs(off) > half || (this.dcGuard && Math.abs(off) < DC_GUARD_HZ)) continue
      const g = Math.floor((centerHz + off - SONDE_LOW_HZ) / GRID_HZ)
      if (g < 0 || g >= this.hold.length) continue
      const p = this.re[k] * this.re[k] + this.im[k] * this.im[k]
      if (p > this.hold[g]) this.hold[g] = p
      this.seen[g] = 1
    }
  }

  /** Lumps over the floor, strongest first. */
  candidates(): SondeCandidate[] {
    const n = this.hold.length
    const width = Math.max(1, Math.round(LUMP_HZ / GRID_HZ))
    // power summed over a lump's width, centred on each grid step.
    const sum = new Float32Array(n)
    let acc = 0
    for (let i = 0; i < n + width; i++) {
      if (i < n) acc += this.hold[i]
      if (i - 2 * width - 1 >= 0) acc -= this.hold[i - 2 * width - 1]
      const c = i - width
      if (c >= 0 && c < n) sum[c] = acc
    }
    const looked = Array.from(sum).filter((_, i) => this.seen[i])
    if (!looked.length) return []
    looked.sort((a, b) => a - b)
    const floor = looked[Math.floor(looked.length / 2)] || 1e-30
    const out: SondeCandidate[] = []
    for (let i = 1; i < n - 1; i++) {
      if (!this.seen[i] || sum[i] < sum[i - 1] || sum[i] < sum[i + 1]) continue
      const snrDb = 10 * Math.log10(sum[i] / floor)
      if (snrDb < MIN_SNR_DB) continue
      let w = 0
      let m = 0
      for (let j = Math.max(0, i - width); j <= Math.min(n - 1, i + width); j++) {
        w += this.hold[j]
        m += this.hold[j] * j
      }
      out.push({ hz: SONDE_LOW_HZ + (m / w + 0.5) * GRID_HZ, snrDb })
    }
    out.sort((a, b) => b.snrDb - a.snrDb)
    const kept: SondeCandidate[] = []
    for (const c of out) if (!kept.some((k) => Math.abs(k.hz - c.hz) < 2 * LUMP_HZ)) kept.push(c)
    return kept.slice(0, 8)
  }
}

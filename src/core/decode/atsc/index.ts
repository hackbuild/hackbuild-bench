/**
 * Finds over the air tv stations by their pilots.
 *
 * A US station's ATSC 1.0 signal is 6 MHz wide, more than an rtl-sdr takes
 * in, so its picture cannot be decoded here. Every one carries a pilot,
 * though: a steady carrier 309.441 kHz above the channel's lower edge,
 * about 11 dB under the whole signal. In a narrow fft bin that pilot stands
 * some 30 dB over the data around it, so it is heard well before the
 * picture would be watchable, and it marks the station plainly.
 *
 * ATSC 3.0 has no pilot. It shows instead as a flat raised floor across the
 * channel, which this reports as wideband with no pilot.
 *
 * The pilots are held to within a few hundred hertz, so the error each one
 * reads also measures the radio's crystal.
 */

import { Fft } from '@/core/dsp/fft'

/** A US broadcast channel after the 2020 repack: 6 MHz from its lower edge. */
export interface TvChannel {
  number: number
  lowHz: number
}

export const CHANNEL_HZ = 6_000_000
/** The pilot's place above the lower edge, from A/53. */
export const PILOT_OFFSET_HZ = 309_440.559

function channels(): TvChannel[] {
  const out: TvChannel[] = []
  // vhf low. channel 5 starts above the 72 to 76 MHz gap.
  for (let n = 2; n <= 4; n++) out.push({ number: n, lowHz: 54e6 + (n - 2) * CHANNEL_HZ })
  for (let n = 5; n <= 6; n++) out.push({ number: n, lowHz: 76e6 + (n - 5) * CHANNEL_HZ })
  for (let n = 7; n <= 13; n++) out.push({ number: n, lowHz: 174e6 + (n - 7) * CHANNEL_HZ })
  // uhf ends at 36 since the repack. 37 is kept for radio astronomy.
  for (let n = 14; n <= 36; n++) out.push({ number: n, lowHz: 470e6 + (n - 14) * CHANNEL_HZ })
  return out
}

export const TV_CHANNELS: readonly TvChannel[] = channels()

export function bandOf(ch: TvChannel): 'vhf low' | 'vhf high' | 'uhf' {
  return ch.number <= 6 ? 'vhf low' : ch.number <= 13 ? 'vhf high' : 'uhf'
}

/** The pilot sits this far below the window centre, clear of the dc spike. */
const PILOT_BELOW_CENTRE_HZ = 600_000
/** The share of a window trusted, away from the filter's skirts. */
const KEEP = 0.75
export const FFT_SIZE = 16_384
/** Transforms averaged per look. */
export const FRAMES_PER_LOOK = 12
/** The pilot is looked for this far either side of where it belongs, which covers a radio 60 ppm off at 608 MHz. */
const SEARCH_HZ = 40_000
/** The pilot's level is judged against bins this far out either side of it. */
const REFERENCE_HZ = 100_000
/** The data band starts this far over the lower edge, past the pilot and the rolloff. */
const DATA_FROM_HZ = 650_000
const DC_GUARD_HZ = 25_000
/** A pilot this far over its surroundings is a station. */
export const PILOT_MIN_DB = 12
/** A channel this far over the quiet ones with no pilot is wideband, likely ATSC 3.0. */
export const WIDE_MIN_DB = 4

/** Where the radio sits to look at a channel. */
export function windowCentre(ch: TvChannel): number {
  return Math.round(ch.lowHz + PILOT_OFFSET_HZ + PILOT_BELOW_CENTRE_HZ)
}

export interface ChannelLook {
  channel: number
  /** Pilot over the bins around it, in dB. */
  pilotDb: number
  /** Where the pilot was heard, minus where it belongs, in Hz. Only meaningful with a pilot. */
  pilotErrorHz: number
  /** Mean power across the part of the data band in view, dB of full scale per bin. */
  dataDb: number
}

export type TvKind = 'atsc 1.0' | 'wideband, no pilot' | 'none'

export interface ChannelResult extends ChannelLook {
  kind: TvKind
  /** The data band over the quiet channels of the same pass, in dB. */
  overFloorDb: number
}

/** Averages power spectra of one window until there are enough to look. */
export class TvLook {
  private readonly fft = new Fft(FFT_SIZE)
  private readonly re = new Float32Array(FFT_SIZE)
  private readonly im = new Float32Array(FFT_SIZE)
  private readonly win = new Float32Array(FFT_SIZE)
  /** Power per bin, summed over `frames`, in fft order. */
  private readonly sum = new Float64Array(FFT_SIZE)
  private fill = 0
  frames = 0
  centerHz = 0
  rate = 0

  constructor() {
    for (let i = 0; i < FFT_SIZE; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE)
  }

  reset(): void {
    this.sum.fill(0)
    this.fill = 0
    this.frames = 0
  }

  feed(iq: Float32Array, centerHz: number, rate: number): void {
    // a transform begun in another window would put its signals at this one's offsets.
    if (centerHz !== this.centerHz || rate !== this.rate) {
      this.reset()
      this.centerHz = centerHz
      this.rate = rate
    }
    for (let n = 0; n + 1 < iq.length; n += 2) {
      this.re[this.fill] = iq[n] * this.win[this.fill]
      this.im[this.fill] = iq[n + 1] * this.win[this.fill]
      if (++this.fill === FFT_SIZE) {
        this.fill = 0
        this.fft.transform(this.re, this.im)
        for (let k = 0; k < FFT_SIZE; k++) this.sum[k] += this.re[k] * this.re[k] + this.im[k] * this.im[k]
        this.frames++
      }
    }
  }

  /** The bin holding an absolute frequency, or -1 outside the trusted part. */
  private binOf(hz: number): number {
    const off = hz - this.centerHz
    if (Math.abs(off) > (this.rate * KEEP) / 2) return -1
    const k = Math.round((off / this.rate) * FFT_SIZE)
    return (k + FFT_SIZE) % FFT_SIZE
  }

  private power(hz: number): number {
    const k = this.binOf(hz)
    return k < 0 ? Number.NaN : this.sum[k] / Math.max(1, this.frames)
  }

  /** True when the window holds the pilot's search span and some of the data band. */
  covers(ch: TvChannel): boolean {
    const pilot = ch.lowHz + PILOT_OFFSET_HZ
    const half = (this.rate * KEEP) / 2
    return (
      pilot - REFERENCE_HZ >= this.centerHz - half &&
      pilot + REFERENCE_HZ <= this.centerHz + half &&
      ch.lowHz + DATA_FROM_HZ + 200_000 <= this.centerHz + half
    )
  }

  /** Reads a channel out of the averaged window, or null when the window does not hold it. */
  look(ch: TvChannel): ChannelLook | null {
    if (!this.frames || !this.covers(ch)) return null
    const binHz = this.rate / FFT_SIZE
    const pilot = ch.lowHz + PILOT_OFFSET_HZ

    let best = -1
    let bestHz = pilot
    for (let hz = pilot - SEARCH_HZ; hz <= pilot + SEARCH_HZ; hz += binHz) {
      const p = this.power(hz)
      if (p > best) {
        best = p
        bestHz = hz
      }
    }
    // a parabola through the peak and its neighbours places it within a bin.
    const a = this.power(bestHz - binHz)
    const c = this.power(bestHz + binHz)
    const la = 10 * Math.log10(a || 1e-30)
    const lb = 10 * Math.log10(best || 1e-30)
    const lc = 10 * Math.log10(c || 1e-30)
    const den = la - 2 * lb + lc
    const shift = den < 0 ? (0.5 * (la - lc)) / den : 0
    const peakHz = bestHz + Math.max(-0.5, Math.min(0.5, shift)) * binHz

    const around: number[] = []
    for (let hz = pilot - REFERENCE_HZ; hz <= pilot + REFERENCE_HZ; hz += binHz) {
      if (Math.abs(hz - peakHz) < 3 * binHz) continue
      const p = this.power(hz)
      if (Number.isFinite(p)) around.push(p)
    }
    around.sort((x, y) => x - y)
    const ref = around[Math.floor(around.length / 2)] || 1e-30

    let data = 0
    let count = 0
    const top = Math.min(ch.lowHz + CHANNEL_HZ - DATA_FROM_HZ, this.centerHz + (this.rate * KEEP) / 2)
    for (let hz = ch.lowHz + DATA_FROM_HZ; hz <= top; hz += binHz) {
      if (Math.abs(hz - this.centerHz) < DC_GUARD_HZ) continue
      const p = this.power(hz)
      if (!Number.isFinite(p)) continue
      data += p
      count++
    }

    return {
      channel: ch.number,
      pilotDb: 10 * Math.log10(best / ref),
      pilotErrorHz: peakHz - pilot,
      dataDb: 10 * Math.log10((data / Math.max(1, count)) / (FFT_SIZE * FFT_SIZE) || 1e-30),
    }
  }
}

/**
 * Names what each channel holds. The quiet floor is the lower quartile of
 * the data levels in the pass, since most channels anywhere are empty.
 */
export function classify(looks: ChannelLook[]): ChannelResult[] {
  if (!looks.length) return []
  const levels = looks.map((l) => l.dataDb).sort((a, b) => a - b)
  const floor = levels[Math.floor((levels.length - 1) / 4)]
  return looks.map((l) => {
    const overFloorDb = l.dataDb - floor
    const kind: TvKind =
      l.pilotDb >= PILOT_MIN_DB ? 'atsc 1.0' : overFloorDb >= WIDE_MIN_DB ? 'wideband, no pilot' : 'none'
    return { ...l, kind, overFloorDb }
  })
}

/**
 * The ppm to set on the radio, from the pilots heard. A pilot reading high
 * means the radio tuned low, which a crystal running slow does. Null when
 * fewer than two stations agree enough to trust.
 */
export function ppmFromPilots(results: ChannelResult[], currentPpm: number): { ppm: number; stations: number; spread: number } | null {
  const reads = results
    .filter((r) => r.kind === 'atsc 1.0' && r.pilotDb >= PILOT_MIN_DB + 6)
    .map((r) => {
      const ch = TV_CHANNELS.find((c) => c.number === r.channel)!
      return (r.pilotErrorHz / (ch.lowHz + PILOT_OFFSET_HZ)) * 1e6
    })
    .sort((a, b) => a - b)
  if (reads.length < 2) return null
  const mid = reads[Math.floor(reads.length / 2)]
  const spread = reads[reads.length - 1] - reads[0]
  return { ppm: currentPpm - mid, stations: reads.length, spread }
}

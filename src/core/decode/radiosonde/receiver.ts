/**
 * From IQ to RS41 frames: one channel pulled out at the sonde's frequency,
 * an fm discriminator, then the bit and frame layers.
 *
 * Between frames the mixer is moved by the average carrier offset the last
 * frame showed, so a sonde whose oscillator drifts as it climbs and cools
 * stays in the middle of the filter.
 */

import { ChannelFilter } from '@/core/dsp/channel'
import { Rs41Calibration, Rs41Decoder } from './rs41'
import type { Rs41Frame } from './rs41'

/** Half width of the channel. The tones sit near 2.1 kHz either side, and narrower than this costs more than the noise it keeps out. */
const CHANNEL_HALF_HZ = 4_000
const WORK_MIN_RATE = 48_000
/** Furthest the frequency correction may walk from where it was told to listen. */
const AFC_LIMIT_HZ = 6_000

export interface SondeFrameMeta {
  /** Where the sonde was heard, Hz, after the frequency correction. */
  frequencyHz: number
  levelDb: number
  /** Input samples handled when the frame ended. */
  atSample: number
}

export class SondeReceiver {
  onFrame: ((f: Rs41Frame, meta: SondeFrameMeta) => void) | null = null
  /** Frames whose header was found but which neither corrected nor checked. */
  get failed(): number {
    return this.demod?.failed ?? 0
  }

  readonly calibration = new Rs41Calibration()
  private targetHz = 0
  private afcHz = 0
  private rate = 0
  private center = 0
  private filter: ChannelFilter | null = null
  private demod: Rs41Decoder | null = null
  private lastI = 0
  private lastQ = 0
  private toHz = 1
  private power = 0
  private freqSum = 0
  private freqN = 0
  private consumed = 0

  /** Listen at this absolute frequency. */
  tune(hz: number): void {
    this.targetHz = hz
    this.afcHz = 0
    this.rate = 0
  }

  get frequencyHz(): number {
    return this.targetHz + this.afcHz
  }

  get samples(): number {
    return this.consumed
  }

  feed(iq: Float32Array, centerHz: number, sampleRate: number): void {
    if (!this.targetHz) return
    if (sampleRate !== this.rate || centerHz !== this.center) this.configure(centerHz, sampleRate)
    const f = this.filter
    const d = this.demod
    if (!f || !d) return
    for (let n = 0; n < iq.length; n += 2) {
      if (!f.push(iq[n], iq[n + 1])) continue
      const i = f.outI
      const q = f.outQ
      const p = i * i + q * q
      this.power = this.power * 0.999 + p * 0.001
      const re = i * this.lastI + q * this.lastQ
      const im = q * this.lastI - i * this.lastQ
      this.lastI = i
      this.lastQ = q
      const hz = Math.atan2(im, re) * this.toHz
      // the carrier offset is averaged only where there is signal.
      if (p > this.power * 0.5) {
        this.freqSum += hz
        this.freqN++
      }
      d.push(hz)
    }
    this.consumed += iq.length / 2
  }

  private configure(centerHz: number, sampleRate: number): void {
    this.rate = sampleRate
    this.center = centerHz
    const off = this.targetHz + this.afcHz - centerHz
    if (Math.abs(off) + CHANNEL_HALF_HZ > sampleRate / 2) {
      this.filter = null
      this.demod = null
      return
    }
    this.filter = new ChannelFilter(off, sampleRate, CHANNEL_HALF_HZ, WORK_MIN_RATE)
    this.toHz = this.filter.outRate / (2 * Math.PI)
    this.demod = new Rs41Decoder(this.filter.outRate, this.calibration)
    this.demod.onHeader = () => this.header()
    this.demod.onFrame = (f) => this.frame(f)
  }

  /** A header was found, so the average is over a sonde and not noise, whether or not the frame survives. */
  private header(): void {
    const offset = this.freqN ? this.freqSum / this.freqN : 0
    this.freqSum = 0
    this.freqN = 0
    if (this.filter) {
      this.afcHz = Math.max(-AFC_LIMIT_HZ, Math.min(AFC_LIMIT_HZ, this.afcHz + offset * 0.5))
      this.filter.retune(this.targetHz + this.afcHz - this.center)
    }
  }

  private frame(f: Rs41Frame): void {
    this.onFrame?.(f, {
      frequencyHz: this.frequencyHz,
      levelDb: 10 * Math.log10(this.power + 1e-20),
      atSample: this.consumed,
    })
  }
}

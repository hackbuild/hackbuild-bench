/**
 * The sweep engine.
 *
 * A sweep box is a receiver that refuses to settle. It hops channels faster
 * than the ear can resolve, with squelch off and gain wide open, so what comes
 * out is the band itself rather than any one station. A speech model then does
 * what a speech model does with noise, which is invent language. Nothing here
 * detects anything.
 */

import type { DemodMode } from '@/core/dsp/demod'

export type SweepDirection = 'up' | 'down' | 'bounce' | 'random'

export interface SweepBand {
  id: string
  name: string
  startHz: number
  stopHz: number
  stepHz: number
  mode: DemodMode
  bandwidthHz: number
  /** Below about 24 MHz an rtl-sdr needs direct sampling to hear anything. */
  needsDirectSampling?: boolean
}

export const SWEEP_BANDS: SweepBand[] = [
  {
    id: 'fm',
    name: 'fm broadcast, 88 to 108',
    startHz: 88e6,
    stopHz: 108e6,
    stepHz: 200e3,
    mode: 'fm',
    bandwidthHz: 200000,
  },
  {
    id: 'am',
    name: 'am broadcast, 530 to 1700',
    startHz: 530e3,
    stopHz: 1700e3,
    stepHz: 10e3,
    mode: 'am',
    bandwidthHz: 8000,
    needsDirectSampling: true,
  },
  {
    id: 'air',
    name: 'airband am, 118 to 137',
    startHz: 118e6,
    stopHz: 137e6,
    stepHz: 25e3,
    mode: 'am',
    bandwidthHz: 8000,
  },
  {
    id: 'vhf',
    name: 'vhf high, 136 to 174',
    startHz: 136e6,
    stopHz: 174e6,
    stepHz: 12.5e3,
    mode: 'nfm',
    bandwidthHz: 12500,
  },
  {
    id: 'gmrs',
    name: 'frs and gmrs, 462 to 468',
    startHz: 462e6,
    stopHz: 468e6,
    stepHz: 12.5e3,
    mode: 'nfm',
    bandwidthHz: 12500,
  },
  {
    id: 'uhf',
    name: 'uhf business, 450 to 470',
    startHz: 450e6,
    stopHz: 470e6,
    stepHz: 12.5e3,
    mode: 'nfm',
    bandwidthHz: 12500,
  },
]

export function bandById(id: string): SweepBand | undefined {
  return SWEEP_BANDS.find((b) => b.id === id)
}

/** One dwell window of audio, tagged with the span the sweep covered in it. */
export interface DwellWindow {
  index: number
  startedAt: number
  endedAt: number
  /** Lowest and highest frequency visited during the window. */
  lowHz: number
  highHz: number
  /** Where the sweep entered and left the window. */
  fromHz: number
  toHz: number
  hops: number
  pass: number
}

export interface SpiritBoxConfig {
  band: SweepBand
  startHz: number
  stopHz: number
  stepHz: number
  direction: SweepDirection
  /** Milliseconds spent on each channel. */
  dwellMs: number
  /** Seconds of audio grouped into one reported window. */
  windowSec: number
  /** Milliseconds of audio to blank over the retune click. */
  blankMs: number
}

export interface SpiritBoxHooks {
  /** Retune the receiver. Awaited, so a slow i2c write throttles the sweep. */
  tune(hz: number): void | Promise<void>
  onHop?(hz: number, hops: number): void
  onDwell?(window: DwellWindow): void
  onError?(message: string): void
}

export type SpiritBoxOptions = Partial<SpiritBoxConfig> & SpiritBoxHooks

const DEFAULTS: Omit<SpiritBoxConfig, 'band' | 'startHz' | 'stopHz' | 'stepHz'> = {
  direction: 'up',
  dwellMs: 120,
  windowSec: 4,
  blankMs: 8,
}

export class SpiritBox {
  private cfg: SpiritBoxConfig
  private hooks: SpiritBoxHooks
  private timer: ReturnType<typeof setTimeout> | null = null
  private on = false
  private freq = 0
  private sign = 1
  private hopCount = 0
  private passCount = 0
  private blankRemainingMs = 0

  private windowIndex = 0
  private windowStart = 0
  private windowLow = 0
  private windowHigh = 0
  private windowFrom = 0
  private windowHops = 0

  constructor(opts: SpiritBoxOptions) {
    const band = opts.band ?? SWEEP_BANDS[0]
    this.cfg = {
      band,
      startHz: opts.startHz ?? band.startHz,
      stopHz: opts.stopHz ?? band.stopHz,
      stepHz: opts.stepHz ?? band.stepHz,
      direction: opts.direction ?? DEFAULTS.direction,
      dwellMs: opts.dwellMs ?? DEFAULTS.dwellMs,
      windowSec: opts.windowSec ?? DEFAULTS.windowSec,
      blankMs: opts.blankMs ?? DEFAULTS.blankMs,
    }
    this.hooks = {
      tune: opts.tune,
      onHop: opts.onHop,
      onDwell: opts.onDwell,
      onError: opts.onError,
    }
    this.freq = this.cfg.startHz
  }

  get config(): Readonly<SpiritBoxConfig> {
    return this.cfg
  }

  get running(): boolean {
    return this.on
  }

  /** The channel the receiver is sitting on right now. */
  get frequency(): number {
    return this.freq
  }

  get hops(): number {
    return this.hopCount
  }

  get passes(): number {
    return this.passCount
  }

  /** Short line for a heads up display: frequency, hop count, pass number. */
  get readout(): string {
    const mhz = (this.freq / 1e6).toFixed(3)
    return `${mhz} MHz, ${this.hopCount} hops, pass ${this.passCount + 1}`
  }

  /**
   * Apply changes. Range and direction take effect on the next hop, so the
   * sweep can be steered while it runs.
   */
  configure(patch: Partial<SpiritBoxConfig>): void {
    if (patch.band) {
      this.cfg.band = patch.band
      this.cfg.startHz = patch.startHz ?? patch.band.startHz
      this.cfg.stopHz = patch.stopHz ?? patch.band.stopHz
      this.cfg.stepHz = patch.stepHz ?? patch.band.stepHz
    } else {
      if (patch.startHz !== undefined) this.cfg.startHz = patch.startHz
      if (patch.stopHz !== undefined) this.cfg.stopHz = patch.stopHz
      if (patch.stepHz !== undefined) this.cfg.stepHz = patch.stepHz
    }
    if (patch.direction !== undefined) this.cfg.direction = patch.direction
    if (patch.dwellMs !== undefined) this.cfg.dwellMs = Math.max(20, patch.dwellMs)
    if (patch.windowSec !== undefined) this.cfg.windowSec = Math.max(1, patch.windowSec)
    if (patch.blankMs !== undefined) this.cfg.blankMs = Math.max(0, patch.blankMs)
    this.freq = this.clampToBand(this.freq)
  }

  /** Throws when the range is unusable, so the caller can say why in place. */
  start(): void {
    if (this.on) return
    if (!(this.cfg.stopHz > this.cfg.startHz)) {
      throw new Error('the stop frequency has to sit above the start')
    }
    if (!(this.cfg.stepHz > 0)) {
      throw new Error('the step has to be greater than zero')
    }
    this.on = true
    this.hopCount = 0
    this.passCount = 0
    this.sign = this.cfg.direction === 'down' ? -1 : 1
    this.freq = this.cfg.direction === 'down' ? this.cfg.stopHz : this.cfg.startHz
    this.openWindow(this.freq)
    this.loop()
  }

  stop(): void {
    if (!this.on) return
    this.on = false
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.closeWindow()
  }

  /**
   * Samples the caller should zero to cover the retune click, at the rate the
   * audio is running. Reading it consumes the blanking request.
   */
  takeBlankSamples(sampleRate: number): number {
    if (this.blankRemainingMs <= 0) return 0
    const n = Math.round((this.blankRemainingMs / 1000) * sampleRate)
    this.blankRemainingMs = 0
    return n
  }

  // -------------------------------------------------------------------------

  private clampToBand(hz: number): number {
    return Math.min(this.cfg.stopHz, Math.max(this.cfg.startHz, hz))
  }

  private next(): number {
    const { startHz, stopHz, stepHz, direction } = this.cfg
    if (direction === 'random') {
      const slots = Math.max(1, Math.round((stopHz - startHz) / stepHz))
      return this.clampToBand(startHz + Math.floor(Math.random() * (slots + 1)) * stepHz)
    }
    let f = this.freq + this.sign * stepHz
    if (f > stopHz) {
      if (direction === 'bounce') {
        this.sign = -1
        f = stopHz - stepHz
      } else {
        f = startHz
        this.passCount++
      }
    } else if (f < startHz) {
      if (direction === 'bounce') {
        this.sign = 1
        f = startHz + stepHz
      } else {
        f = stopHz
        this.passCount++
      }
    }
    return this.clampToBand(f)
  }

  private openWindow(at: number): void {
    this.windowStart = Date.now()
    this.windowLow = at
    this.windowHigh = at
    this.windowFrom = at
    this.windowHops = 0
  }

  private closeWindow(): void {
    if (this.windowHops === 0) return
    const window: DwellWindow = {
      index: this.windowIndex++,
      startedAt: this.windowStart,
      endedAt: Date.now(),
      lowHz: this.windowLow,
      highHz: this.windowHigh,
      fromHz: this.windowFrom,
      toHz: this.freq,
      hops: this.windowHops,
      pass: this.passCount,
    }
    this.hooks.onDwell?.(window)
    this.openWindow(this.freq)
  }

  private async tick(): Promise<void> {
    if (!this.on) return
    const f = this.next()
    this.freq = f
    this.hopCount++
    this.windowHops++
    if (f < this.windowLow) this.windowLow = f
    if (f > this.windowHigh) this.windowHigh = f

    await this.hooks.tune(f)
    this.blankRemainingMs = this.cfg.blankMs
    this.hooks.onHop?.(f, this.hopCount)

    if (Date.now() - this.windowStart >= this.cfg.windowSec * 1000) this.closeWindow()
  }

  private loop(): void {
    if (!this.on) return
    this.tick()
      .catch((err) => {
        this.hooks.onError?.(err instanceof Error ? err.message : String(err))
      })
      .then(() => {
        if (this.on) this.timer = setTimeout(() => this.loop(), this.cfg.dwellMs)
      })
  }
}

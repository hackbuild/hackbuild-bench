/**
 * Burst detection and pulse timing, OOK and FSK.
 *
 * A port of rtl_433's pulse_detect.c and pulse_detect_fsk.c
 * (GPL-2.0-or-later, Tommy Vestermark, Benjamin Larsson, Christian W.
 * Zuckschwerdt). The noise floor is tracked while idle, a burst starts when
 * the envelope clears the floor by the high to low ratio, and an FSK signal
 * shows up as one long OOK pulse whose frequency swings are timed instead.
 */

import { PD_MAX_PULSES, clearPulseData } from './types'
import type { PulseData } from './types'

export const PULSE_NONE = 0
export const PULSE_OOK = 1
export const PULSE_FSK = 2

const PD_MIN_PULSES = 16
const PD_MIN_PULSE_SAMPLES = 10
const PD_MIN_GAP_MS = 10
const PD_MAX_GAP_MS = 100
const PD_MAX_GAP_RATIO = 10

const OOK_MAX_HIGH_LEVEL = Math.trunc(10 ** ((0 + 42.1442) / 10))
const OOK_EST_HIGH_RATIO = 64
const OOK_EST_LOW_RATIO = 1024

const FSK_DEFAULT_FM_DELTA = 6000
const FSK_EST_SLOW = 64
const FSK_EST_FAST = 16

const IDLE = 0
const PULSE = 1
const GAP_START = 2
const GAP = 3

const F_INIT = 0
const F_HIGH = 1
const F_LOW = 2

const div = (a: number, b: number): number => Math.trunc(a / b)

/** Which FSK tracker runs: rtl_433 uses the min max one above 800 MHz. */
export type FskMode = 'classic' | 'minmax'

class FskDetect {
  len = 0
  state = F_INIT
  f1 = 0
  f2 = 0
  varMax = -32768
  varMin = 32767
  skip = 40

  init(): void {
    this.len = 0
    this.state = F_INIT
    this.f1 = 0
    this.f2 = 0
    this.varMax = -32768
    this.varMin = 32767
    this.skip = 40
  }

  classic(fm: number, p: PulseData): void {
    const d1 = Math.abs(fm - this.f1)
    const d2 = Math.abs(fm - this.f2)
    this.len += 1
    switch (this.state) {
      case F_INIT:
        if (this.len < PD_MIN_PULSE_SAMPLES) {
          this.f1 = div(this.f1, 2) + div(fm, 2)
        } else if (d1 > FSK_DEFAULT_FM_DELTA / 2) {
          if (fm > this.f1) {
            this.state = F_HIGH
            this.f2 = this.f1
            this.f1 = fm
            p.pulse[0] = 0
            p.gap[0] = this.len
            p.num += 1
            this.len = 0
          } else {
            this.state = F_LOW
            this.f2 = fm
            p.pulse[0] = this.len
            this.len = 0
          }
        } else {
          this.f1 += div(fm, FSK_EST_FAST) - div(this.f1, FSK_EST_FAST)
        }
        break
      case F_HIGH:
        if (d1 > d2) {
          this.state = F_LOW
          if (this.len >= PD_MIN_PULSE_SAMPLES) {
            p.pulse[p.num] = this.len
            this.len = 0
          } else if (p.num > 0) {
            this.len += p.gap[p.num - 1]
            p.num -= 1
            if (p.num === 0 && p.pulse[0] === 0) {
              this.f1 = this.f2
              this.state = F_INIT
            }
          }
        } else if (fm > this.f1) {
          this.f1 += div(fm, FSK_EST_FAST) - div(this.f1, FSK_EST_FAST)
        } else {
          this.f1 += div(fm, FSK_EST_SLOW) - div(this.f1, FSK_EST_SLOW)
        }
        break
      case F_LOW:
        if (d2 > d1) {
          this.state = F_HIGH
          if (this.len >= PD_MIN_PULSE_SAMPLES) {
            p.gap[p.num] = this.len
            p.num += 1
            this.len = 0
            if (p.num >= PD_MAX_PULSES) shiftPulses(p)
          } else {
            this.len += p.pulse[p.num]
            if (p.num === 0) this.state = F_INIT
          }
        } else if (fm < this.f2) {
          this.f2 += div(fm, FSK_EST_FAST) - div(this.f2, FSK_EST_FAST)
        } else {
          this.f2 += div(fm, FSK_EST_SLOW) - div(this.f2, FSK_EST_SLOW)
        }
        break
      default:
        break
    }
  }

  wrapUp(p: PulseData): void {
    if (p.num >= PD_MAX_PULSES) return
    this.len += 1
    if (this.state === F_HIGH) {
      p.pulse[p.num] = this.len
      p.gap[p.num] = 0
    } else {
      p.gap[p.num] = this.len
    }
    p.num += 1
  }

  minmax(fm: number, p: PulseData): void {
    if (!this.skip) {
      this.varMax = Math.max(fm, this.varMax)
      this.varMin = Math.min(fm, this.varMin)
      const mid = div(this.varMax + this.varMin, 2)
      if (fm > mid) this.varMax -= 10
      if (fm < mid) this.varMin += 10
      this.len += 1
      switch (this.state) {
        case F_INIT:
          this.state = fm > mid ? F_HIGH : F_LOW
          break
        case F_HIGH:
          if (fm < mid) {
            this.state = F_LOW
            p.pulse[p.num] = this.len
            this.len = 0
          }
          this.f2 += div(fm, FSK_EST_SLOW) - div(this.f2, FSK_EST_SLOW)
          break
        case F_LOW:
          if (fm > mid) {
            this.state = F_HIGH
            p.gap[p.num] = this.len
            p.num += 1
            this.len = 0
            if (p.num >= PD_MAX_PULSES) shiftPulses(p)
          }
          this.f1 += div(fm, FSK_EST_SLOW) - div(this.f1, FSK_EST_SLOW)
          break
        default:
          break
      }
    }
    if (this.skip > 0) this.skip -= 1
  }
}

function shiftPulses(p: PulseData): void {
  const offs = PD_MAX_PULSES / 2
  p.pulse.copyWithin(0, offs)
  p.gap.copyWithin(0, offs)
  p.num -= offs
  p.offset += offs
}

export interface DetectLevels {
  /** Lowest level a burst can start at, dB full scale. */
  minLevelDb: number
  /** Margin a burst needs over the noise floor, dB. */
  minSnrDb: number
}

export const DEFAULT_LEVELS: DetectLevels = { minLevelDb: -12.1442, minSnrDb: 9 }

export class PulseDetector {
  private state = IDLE
  private pulseLength = 0
  private maxPulse = 0
  private dataCounter = 0
  private leadIn = 0
  private ookLow = 0
  private ookHigh = 0
  private minHigh: number
  private ratio: number
  private fsk = new FskDetect()

  constructor(levels: DetectLevels = DEFAULT_LEVELS) {
    this.minHigh = Math.trunc(10 ** ((levels.minLevelDb + 42.1442) / 10))
    this.ratio = Math.trunc(0.5 + 10 ** (levels.minSnrDb / 10))
  }

  reset(): void {
    this.state = IDLE
    this.pulseLength = 0
    this.maxPulse = 0
    this.dataCounter = 0
    this.leadIn = 0
    this.ookLow = 0
    this.ookHigh = 0
    this.fsk.init()
  }

  /** Noise floor estimate in the envelope's scale. */
  get noiseLevel(): number {
    return this.ookLow
  }

  /**
   * Walks the block from where the last call stopped. Returns PULSE_OOK or
   * PULSE_FSK when a package completed, with the position kept so the next
   * call carries on, or PULSE_NONE once the block is used up.
   */
  detect(
    env: Int16Array,
    fm: Int16Array,
    len: number,
    rate: number,
    blockOffset: number,
    ook: PulseData,
    fskp: PulseData,
    mode: FskMode,
  ): number {
    const perMs = Math.trunc(rate / 1000)
    this.ookHigh = Math.max(this.ookHigh, this.minHigh)
    let eop = 0
    while (this.dataCounter < len) {
      const am = env[this.dataCounter]
      const thr = Math.trunc((this.ookLow + Math.min(this.ookHigh, OOK_MAX_HIGH_LEVEL)) / 2)
      const hyst = Math.trunc(thr / 8)
      switch (this.state) {
        case IDLE:
          if (am > thr + hyst && this.leadIn > OOK_EST_LOW_RATIO) {
            clearPulseData(ook)
            clearPulseData(fskp)
            ook.sampleRate = rate
            fskp.sampleRate = rate
            ook.offset = blockOffset + this.dataCounter
            fskp.offset = blockOffset + this.dataCounter
            this.pulseLength = 0
            this.maxPulse = 0
            this.fsk.init()
            this.state = PULSE
          } else {
            const delta = am - this.ookLow
            this.ookLow += Math.trunc(delta / OOK_EST_LOW_RATIO)
            this.ookLow += delta > 0 ? 1 : -1
            this.ookHigh = Math.max(this.ratio * this.ookLow, this.minHigh)
            if (this.leadIn <= OOK_EST_LOW_RATIO) this.leadIn += 1
          }
          break
        case PULSE:
          this.pulseLength += 1
          if (am < thr - hyst) {
            if (this.pulseLength < PD_MIN_PULSE_SAMPLES) {
              if (ook.num <= 1) {
                this.state = IDLE
              } else {
                eop = 1
                this.state = GAP
              }
            } else {
              ook.pulse[ook.num] = this.pulseLength
              this.maxPulse = Math.max(this.pulseLength, this.maxPulse)
              this.pulseLength = 0
              this.state = GAP_START
            }
          } else {
            this.ookHigh += Math.trunc(am / OOK_EST_HIGH_RATIO) - Math.trunc(this.ookHigh / OOK_EST_HIGH_RATIO)
            this.ookHigh = Math.max(this.ookHigh, this.minHigh)
            ook.fskF1 += Math.trunc(fm[this.dataCounter] / OOK_EST_HIGH_RATIO) - Math.trunc(ook.fskF1 / OOK_EST_HIGH_RATIO)
          }
          if (ook.num === 0) this.runFsk(fm[this.dataCounter], fskp, mode)
          break
        case GAP_START:
          this.pulseLength += 1
          if (am > thr + hyst) {
            this.pulseLength += ook.pulse[ook.num]
            this.state = PULSE
          } else if (this.pulseLength >= PD_MIN_PULSE_SAMPLES) {
            this.state = GAP
            if (fskp.num > PD_MIN_PULSES) {
              if (mode === 'classic') this.fsk.wrapUp(fskp)
              fskp.fskF1 = this.fsk.f1
              fskp.fskF2 = this.fsk.f2
              fskp.ookLow = this.ookLow
              fskp.ookHigh = this.ookHigh
              this.state = IDLE
              return PULSE_FSK
            }
          }
          if (ook.num === 0) this.runFsk(fm[this.dataCounter], fskp, mode)
          break
        case GAP:
          this.pulseLength += 1
          if (am > thr + hyst) {
            ook.gap[ook.num] = this.pulseLength
            ook.num += 1
            if (ook.num >= PD_MAX_PULSES) {
              this.state = IDLE
              ook.ookLow = this.ookLow
              ook.ookHigh = this.ookHigh
              return PULSE_OOK
            }
            this.pulseLength = 0
            this.state = PULSE
          }
          if (
            eop ||
            (this.pulseLength > PD_MAX_GAP_RATIO * this.maxPulse && this.pulseLength > PD_MIN_GAP_MS * perMs) ||
            this.pulseLength > PD_MAX_GAP_MS * perMs
          ) {
            ook.gap[ook.num] = this.pulseLength
            ook.num += 1
            this.state = IDLE
            ook.ookLow = this.ookLow
            ook.ookHigh = this.ookHigh
            return PULSE_OOK
          }
          break
        default:
          this.state = IDLE
      }
      this.dataCounter += 1
    }
    this.dataCounter = 0
    return PULSE_NONE
  }

  private runFsk(fm: number, p: PulseData, mode: FskMode): void {
    if (mode === 'classic') this.fsk.classic(fm, p)
    else this.fsk.minmax(fm, p)
  }
}

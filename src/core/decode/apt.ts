/**
 * NOAA APT, the analogue picture the polar orbiting weather satellites have
 * been sending down on 137 MHz since the sixties.
 *
 * The downlink is fm. Inside the recovered audio a 2400 Hz subcarrier is
 * amplitude modulated with 4160 picture words per second, two lines per
 * second, 2080 words per line. Each line carries two channels side by side,
 * each with its own sync train, space view, image, and telemetry wedges.
 *
 * A real pass needs a satellite above the horizon and an antenna that can see
 * it, normally a turnstile or a v dipole. The picture builds over the whole
 * pass, roughly ten minutes, so expect around 1200 lines before the bird sets
 * and the signal drops back into the noise.
 */

import { AmEnvelope, LinearResampler, SampleTrace, clamp01 } from './signal'

export const APT_CARRIER_HZ = 2400
export const APT_WORD_RATE = 4160
export const APT_LINE_WORDS = 2080

/** Word offsets inside one line. Both channels are 909 words wide. */
export const APT_CHANNEL_A = { offset: 86, width: 909 }
export const APT_CHANNEL_B = { offset: 1126, width: 909 }
export const APT_TELEMETRY_A = { offset: 995, width: 45 }
export const APT_TELEMETRY_B = { offset: 2035, width: 45 }

/**
 * Sync A: four low words then seven cycles of a 1040 Hz square wave, then the
 * run of low words that leads into the space view.
 */
export function aptSyncTemplate(): Float32Array {
  const t = new Float32Array(39)
  let i = 4
  for (let c = 0; c < 7; c++) {
    t[i++] = 1
    t[i++] = 1
    i += 2
  }
  return t
}

/** Sync B is the same shape at 832 Hz, five words per cycle. */
export function aptSyncBTemplate(): Float32Array {
  const t = new Float32Array(39)
  let i = 4
  for (let c = 0; c < 7; c++) {
    t[i++] = 1
    t[i++] = 1
    t[i++] = 1
    i += 2
  }
  return t
}

export interface AptLineEvent {
  y: number
  image: ImageData
}

const GROW_ROWS = 128

export interface AptOptions {
  /** Hard stop on picture height. 1200 lines is a full ten minute pass. */
  maxLines?: number
}

export class AptDecoder {
  onLine: ((e: AptLineEvent) => void) | null = null
  onComplete: ((image: ImageData) => void) | null = null

  private readonly maxLines: number
  private env = new AmEnvelope(APT_CARRIER_HZ, 2100)
  private resamp = new LinearResampler(1)
  private trace = new SampleTrace(1 << 16)
  private sampleRate = 0
  private template: Float32Array
  private templateMean: number
  private hi = 0.5
  private lo = 0
  private locked = false
  private lineAbs = 0
  private scan = 0
  private img: ImageData | null = null
  private rows = 0
  private syncScore = 0

  constructor(opts: AptOptions = {}) {
    this.maxLines = Math.max(16, opts.maxLines ?? 1200)
    this.template = aptSyncTemplate()
    let sum = 0
    for (let i = 0; i < this.template.length; i++) sum += this.template[i] ? 1 : -1
    this.templateMean = sum / this.template.length
  }

  get image(): ImageData | null {
    return this.img
  }

  get lines(): number {
    return this.rows
  }

  /** Correlation of the last accepted line against the sync train, 0 to 1. */
  get lock(): number {
    return this.locked ? this.syncScore : 0
  }

  reset(): void {
    this.env.reset()
    this.resamp.reset()
    this.trace.clear()
    this.hi = 0.5
    this.lo = 0
    this.locked = false
    this.lineAbs = 0
    this.scan = 0
    this.img = null
    this.rows = 0
    this.syncScore = 0
  }

  feed(audio: Float32Array, sampleRate: number): void {
    if (audio.length === 0) return
    if (sampleRate !== this.sampleRate) {
      this.sampleRate = sampleRate
      this.reset()
      this.resamp.setStep(sampleRate / APT_WORD_RATE)
    }

    const envelope = this.env.process(audio, sampleRate)
    const words = this.resamp.process(envelope)
    if (words.length === 0) return

    // the picture is a level mapping, so the levels have to be tracked. these
    // chase a rise quickly and a fall slowly, which is what keeps the space
    // view black through a fade.
    const norm = new Float32Array(words.length)
    for (let i = 0; i < words.length; i++) {
      const v = words[i]
      this.hi += (v - this.hi) * (v > this.hi ? 0.05 : 0.00015)
      this.lo += (v - this.lo) * (v < this.lo ? 0.05 : 0.00015)
      const span = this.hi - this.lo
      norm[i] = span > 1e-6 ? clamp01((v - this.lo) / span) : 0
    }
    this.trace.push(norm)
    this.pump()
  }

  /** Ends the pass and hands over what was decoded. */
  finish(): void {
    if (this.img && this.rows > 0) this.onComplete?.(this.crop())
  }

  // -------------------------------------------------------------------------

  private pump(): void {
    for (;;) {
      if (!this.locked) {
        if (!this.acquire()) break
      } else if (!this.readLine()) {
        break
      }
    }
    this.trace.drop((this.locked ? this.lineAbs : this.scan) - 64)
  }

  /** Scans a whole line for the strongest sync before committing to a phase. */
  private acquire(): boolean {
    if (this.scan < this.trace.base) this.scan = this.trace.base
    const need = this.scan + APT_LINE_WORDS + this.template.length
    if (this.trace.end < need) return false

    let best = this.scan
    let bestScore = -1
    for (let o = this.scan; o < this.scan + APT_LINE_WORDS; o++) {
      const s = this.correlate(o)
      if (s > bestScore) {
        bestScore = s
        best = o
      }
    }
    if (bestScore < 0.18) {
      this.scan += APT_LINE_WORDS
      return true
    }
    this.locked = true
    this.syncScore = bestScore
    this.lineAbs = best
    return true
  }

  private readLine(): boolean {
    const window = 12
    if (this.trace.end < this.lineAbs + APT_LINE_WORDS + window + this.template.length) return false
    if (this.lineAbs - window < this.trace.base) this.lineAbs = this.trace.base + window

    let best = this.lineAbs
    let bestScore = -1
    for (let o = this.lineAbs - window; o <= this.lineAbs + window; o++) {
      const s = this.correlate(o)
      if (s > bestScore) {
        bestScore = s
        best = o
      }
    }
    // a lost sync freewheels on the nominal period rather than dropping the
    // line, so a fade tilts the picture instead of tearing it.
    if (bestScore < 0.1) best = this.lineAbs
    this.syncScore = bestScore

    const img = this.ensureRows(this.rows + 1)
    const o = this.rows * APT_LINE_WORDS * 4
    for (let x = 0; x < APT_LINE_WORDS; x++) {
      const v = clamp01(this.trace.at(best + x)) * 255
      const p = o + x * 4
      img.data[p] = v
      img.data[p + 1] = v
      img.data[p + 2] = v
      img.data[p + 3] = 255
    }
    this.onLine?.({ y: this.rows, image: img })
    this.rows++
    this.lineAbs = best + APT_LINE_WORDS

    if (this.rows >= this.maxLines) {
      this.locked = false
      this.scan = this.lineAbs
      this.onComplete?.(this.crop())
      return false
    }
    return true
  }

  private correlate(at: number): number {
    let sum = 0
    for (let i = 0; i < this.template.length; i++) {
      const t = (this.template[i] ? 1 : -1) - this.templateMean
      sum += t * this.trace.at(at + i)
    }
    return sum / this.template.length
  }

  private ensureRows(need: number): ImageData {
    if (this.img && this.img.height >= need) return this.img
    const height = Math.min(this.maxLines, Math.max(need, (this.img?.height ?? 0) + GROW_ROWS))
    const next = new ImageData(APT_LINE_WORDS, height)
    for (let i = 3; i < next.data.length; i += 4) next.data[i] = 255
    if (this.img) next.data.set(this.img.data, 0)
    this.img = next
    return next
  }

  /** The picture without the unwritten rows the buffer grew in advance. */
  private crop(): ImageData {
    const src = this.img
    if (!src) return new ImageData(APT_LINE_WORDS, 1)
    if (src.height === this.rows) return src
    const out = new ImageData(APT_LINE_WORDS, Math.max(1, this.rows))
    out.data.set(src.data.subarray(0, out.data.length))
    return out
  }
}

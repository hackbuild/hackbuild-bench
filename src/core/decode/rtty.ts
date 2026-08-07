/**
 * Radioteletype.
 *
 * Two tones a fixed shift apart, 45.45 baud on the ham bands, five data bits
 * per character in the Baudot alphabet with a start bit and one and a half
 * stop bits. Two alphabets share the same five bits, and a shift character
 * says which one is in force until the next shift.
 *
 * Received on usb, the tones land at audio. Mark at 2125 Hz with a 170 Hz
 * shift is the usual pairing. When the sideband is the other way round the
 * two tones swap, which comes out as gibberish until reverse is turned on.
 */

import { FreqDiscriminator, SampleTrace } from './signal'

export const RTTY_SHIFTS = [170, 425, 850]
export const RTTY_BAUDS = [45.45, 50, 75, 100]

export interface RttyOptions {
  baud?: number
  shiftHz?: number
  markHz?: number
  /** Swap mark and space, which is what the wrong sideband looks like. */
  reverse?: boolean
}

const LETTERS = [
  '\0', 'E', '\n', 'A', ' ', 'S', 'I', 'U',
  '\r', 'D', 'R', 'J', 'N', 'F', 'C', 'K',
  'T', 'Z', 'L', 'W', 'H', 'Y', 'P', 'Q',
  'O', 'B', 'G', '', 'M', 'X', 'V', '',
]

const FIGURES = [
  '\0', '3', '\n', '-', ' ', "'", '8', '7',
  '\r', '$', '4', '\x07', ',', '!', ':', '(',
  '5', '"', ')', '2', '#', '6', '0', '1',
  '9', '?', '&', '', '.', '/', ';', '',
]

const FIGS_CODE = 0x1b
const LTRS_CODE = 0x1f

/**
 * Text to baudot codes with the shift characters inserted where the alphabet
 * changes. Space and the two line ending codes live in both alphabets, so they
 * never force a shift.
 */
export function baudotEncode(text: string): number[] {
  const out: number[] = []
  let figs = false
  for (const ch of text.toUpperCase()) {
    let code = LETTERS.indexOf(ch)
    let wantFigs = false
    if (code < 1 || code === FIGS_CODE || code === LTRS_CODE) {
      code = FIGURES.indexOf(ch)
      wantFigs = true
    }
    if (code < 1) continue
    const shared = ch === ' ' || ch === '\r' || ch === '\n'
    if (!shared && wantFigs !== figs) {
      out.push(wantFigs ? FIGS_CODE : LTRS_CODE)
      figs = wantFigs
    }
    out.push(code)
  }
  return out
}

export class RttyDecoder {
  /** Fired with whatever characters came out of one feed. */
  onText: ((text: string) => void) | null = null

  private baud: number
  private shiftHz: number
  private markHz: number
  private reverse: boolean

  private disc: FreqDiscriminator
  private trace = new SampleTrace(1 << 16)
  private sampleRate = 0
  private scan = 0
  private figs = false
  private frameErrors = 0

  constructor(opts: RttyOptions = {}) {
    this.baud = opts.baud ?? 45.45
    this.shiftHz = opts.shiftHz ?? 170
    this.markHz = opts.markHz ?? 2125
    this.reverse = opts.reverse ?? false
    this.disc = this.buildDiscriminator()
  }

  /** Characters whose stop bit was not where it should have been. */
  get errors(): number {
    return this.frameErrors
  }

  get options(): Required<RttyOptions> {
    return {
      baud: this.baud,
      shiftHz: this.shiftHz,
      markHz: this.markHz,
      reverse: this.reverse,
    }
  }

  setOptions(opts: RttyOptions): void {
    this.baud = opts.baud ?? this.baud
    this.shiftHz = opts.shiftHz ?? this.shiftHz
    this.markHz = opts.markHz ?? this.markHz
    this.reverse = opts.reverse ?? this.reverse
    this.disc = this.buildDiscriminator()
    this.reset()
  }

  reset(): void {
    this.trace.clear()
    this.disc.reset()
    this.scan = 0
    this.figs = false
    this.frameErrors = 0
  }

  feed(audio: Float32Array, sampleRate: number): void {
    if (audio.length === 0) return
    if (sampleRate !== this.sampleRate) {
      this.sampleRate = sampleRate
      this.reset()
    }
    this.trace.push(this.disc.process(audio, sampleRate))
    const text = this.pump()
    if (text) this.onText?.(text)
  }

  // -------------------------------------------------------------------------

  private buildDiscriminator(): FreqDiscriminator {
    const center = this.markHz + this.shiftHz / 2
    const cutoff = this.shiftHz + this.baud * 3
    return new FreqDiscriminator(center, cutoff, 2)
  }

  private get center(): number {
    return this.markHz + this.shiftHz / 2
  }

  private isMark(hz: number): boolean {
    return this.reverse ? hz > this.center : hz < this.center
  }

  private pump(): string {
    const spb = this.sampleRate / this.baud
    const need = Math.ceil(spb * 7.5)
    let out = ''

    if (this.scan < this.trace.base) this.scan = this.trace.base

    while (this.scan + need < this.trace.end) {
      const edge = this.findStartEdge(this.scan, this.trace.end - need)
      if (edge < 0) {
        this.scan = this.trace.end - need
        break
      }
      // half way into the start bit the line must still be at space.
      if (this.isMark(this.trace.at(edge + spb * 0.5))) {
        this.scan = edge + 1
        continue
      }

      let code = 0
      for (let k = 0; k < 5; k++) {
        const a = edge + spb * (1.2 + k)
        const b = edge + spb * (1.8 + k)
        if (this.isMark(this.trace.mean(a, b))) code |= 1 << k
      }
      const stop = this.trace.mean(edge + spb * 6.1, edge + spb * 6.9)
      if (!this.isMark(stop)) {
        this.frameErrors++
        this.scan = edge + Math.round(spb)
        continue
      }

      out += this.character(code)
      this.scan = edge + Math.round(spb * 6.5)
    }

    this.trace.drop(this.scan - Math.ceil(spb))
    return out
  }

  /** First mark to space transition at or after `from`. */
  private findStartEdge(from: number, to: number): number {
    let prev = this.isMark(this.trace.at(from))
    for (let i = from + 1; i < to; i++) {
      const now = this.isMark(this.trace.at(i))
      if (prev && !now) return i
      prev = now
    }
    return -1
  }

  private character(code: number): string {
    if (code === FIGS_CODE) {
      this.figs = true
      return ''
    }
    if (code === LTRS_CODE) {
      this.figs = false
      return ''
    }
    const ch = (this.figs ? FIGURES : LETTERS)[code] ?? ''
    // carriage returns arrive paired with a line feed, so only one of the two
    // becomes a newline and the text does not double space.
    if (ch === '\r' || ch === '\0' || ch === '\x07') return ''
    return ch
  }
}

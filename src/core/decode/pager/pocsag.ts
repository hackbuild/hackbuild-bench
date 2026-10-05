/**
 * POCSAG, the older of the two paging codes.
 *
 * A transmission is at least 576 bits of 1010 preamble, then batches. Each
 * batch is the sync codeword 0x7CD215D8 and sixteen codewords, two per frame,
 * and a pager only listens in the frame its address puts it in. Every
 * codeword is BCH(31,21) with even parity. A codeword with its top bit clear
 * is an address: eighteen address bits and two function bits, with the low
 * three address bits implied by the frame. One with the top bit set carries
 * twenty message bits. A page runs until the next address or idle codeword.
 *
 * Message bits are numeric digits, four bits each, or 7 bit ascii, both sent
 * least significant bit first. The function bits do not say which. Most
 * networks send numeric on function 0 and text on the others, and that is
 * the reading shown, with the other kept alongside.
 */

import { pocsagCorrect, pocsagEncode } from './bch'
import type { PagerMessage } from './types'

export const POCSAG_SYNC = 0x7cd215d8
export const POCSAG_IDLE = 0x7a89c197
export const POCSAG_BAUDS = [512, 1200, 2400] as const

/** Sixteen codewords per batch, two per frame. */
const BATCH_WORDS = 16
/** A page longer than this is noise that happened to correct. */
const MAX_MESSAGE_BITS = 20 * 400
/** Bad codewords in a row before the batch timing is given up. */
const MAX_BAD_WORDS = 2
/**
 * Share of a batch's codewords that have to decode for its pages to count
 * when the next sync codeword never came. Noise that happened to match the
 * sync word decodes about a quarter of its words, since two bit correction
 * accepts that much of anything. A real final batch decodes nearly all.
 */
const BATCH_QUALITY = 0.85

/** Numeric digits by their bit-reversed nibble. */
const DIGITS = '0123456789.U -]['

function rev4(n: number): number {
  return ((n & 1) << 3) | ((n & 2) << 1) | ((n & 4) >> 1) | ((n & 8) >> 3)
}

export function pocsagNumeric(bits: number[]): string {
  let out = ''
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    const n = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]
    out += DIGITS[rev4(n)]
  }
  return out.trimEnd()
}

/** Character codes, 7 bits each, least significant first. */
export function pocsagChars(bits: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i + 7 <= bits.length; i += 7) {
    let c = 0
    for (let b = 0; b < 7; b++) c |= bits[i + b] << b
    out.push(c)
  }
  return out
}

/** Printable text from character codes. Fill and control characters are dropped. */
export function printable(codes: number[]): string {
  let out = ''
  for (const c of codes) {
    if (c >= 0x20 && c < 0x7f) out += String.fromCharCode(c)
    else if (c === 0x0a || c === 0x0d) out += ' '
  }
  return out.trimEnd()
}

export interface PocsagStats {
  /** Codewords taken in while synced. */
  words: number
  corrected: number
  uncorrectable: number
}

/**
 * The codeword layer for one bit rate. Bits go in one at a time, pages come
 * out through onMessage.
 */
export class PocsagFramer {
  readonly baud: number
  onMessage: ((m: PagerMessage) => void) | null = null
  readonly stats: PocsagStats = { words: 0, corrected: 0, uncorrectable: 0 }
  /** Set when the last sync came in with the bits inverted. */
  inverted = false

  private shift = 0
  private synced = false
  private bitCount = 0
  /** Word position after the sync codeword, 0 to 15, then 16 is the next sync. */
  private wordIndex = 0
  private bad = 0
  private seq = 0

  /** Pages finished in this batch, held until the batch proves it was a signal. */
  private pending: PagerMessage[] = []
  private batchSeen = 0
  private batchGood = 0

  private address = -1
  private func = -1
  private bits: number[] = []
  private corrected = 0
  private damaged = false

  constructor(baud: number) {
    this.baud = baud
  }

  get locked(): boolean {
    return this.synced
  }

  reset(): void {
    this.shift = 0
    this.synced = false
    this.pending = []
    this.dropPage()
  }

  push(bit: number): void {
    this.shift = ((this.shift << 1) | (bit & 1)) >>> 0
    if (!this.synced) {
      this.hunt()
      return
    }
    if (++this.bitCount < 32) return
    this.bitCount = 0
    const raw = this.inverted ? ~this.shift >>> 0 : this.shift
    this.word(raw)
  }

  /** Ends whatever page is open, for a stream that stopped. */
  flush(): void {
    if (this.synced) this.loseSync()
  }

  private loseSync(): void {
    this.finishPage(true)
    this.endBatch(false)
    this.synced = false
  }

  /** Lets the batch's pages out when the batch looked like a signal, and starts the next. */
  private endBatch(confirmed: boolean): void {
    const good = confirmed || (this.batchSeen > 0 && this.batchGood / this.batchSeen >= BATCH_QUALITY)
    const out = good ? this.pending : []
    this.pending = []
    this.batchSeen = 0
    this.batchGood = 0
    for (const m of out) this.onMessage?.(m)
  }

  private hunt(): void {
    for (const inv of [false, true]) {
      const raw = inv ? ~this.shift >>> 0 : this.shift
      const fixed = pocsagCorrect(raw)
      if (fixed.errors >= 0 && fixed.word === POCSAG_SYNC) {
        this.synced = true
        this.inverted = inv
        this.bitCount = 0
        this.wordIndex = 0
        this.bad = 0
        this.pending = []
        this.batchSeen = 0
        this.batchGood = 0
        return
      }
    }
  }

  private word(raw: number): void {
    const fixed = pocsagCorrect(raw)
    this.stats.words++
    const position = this.wordIndex
    this.wordIndex = (this.wordIndex + 1) % (BATCH_WORDS + 1)

    if (position < BATCH_WORDS) this.batchSeen++
    if (fixed.errors < 0) {
      this.stats.uncorrectable++
      if (++this.bad >= MAX_BAD_WORDS || position === BATCH_WORDS) {
        this.loseSync()
        return
      }
      // one lost codeword keeps the batch timing but breaks the page.
      if (this.address >= 0 || this.bits.length) {
        this.damaged = true
        for (let i = 0; i < 20; i++) this.bits.push(0)
      }
      return
    }
    this.bad = 0
    if (fixed.errors > 0) this.stats.corrected++
    const cw = fixed.word

    if (position === BATCH_WORDS) {
      if (cw !== POCSAG_SYNC) this.loseSync()
      else this.endBatch(true)
      return
    }
    this.batchGood++
    if (cw === POCSAG_SYNC) return

    if (cw === POCSAG_IDLE) {
      this.finishPage(false)
      return
    }
    if ((cw & 0x80000000) === 0) {
      this.finishPage(false)
      this.address = ((cw >>> 13) << 3) | (position >> 1)
      this.func = (cw >>> 11) & 3
      this.bits = []
      this.corrected = fixed.errors
      this.damaged = false
      return
    }
    if (this.address < 0) return
    this.corrected += fixed.errors
    for (let b = 30; b >= 11; b--) this.bits.push((cw >>> b) & 1)
    if (this.bits.length > MAX_MESSAGE_BITS) {
      this.damaged = true
      this.loseSync()
    }
  }

  private dropPage(): void {
    this.address = -1
    this.func = -1
    this.bits = []
    this.corrected = 0
    this.damaged = false
  }

  private finishPage(lost: boolean): void {
    if (this.address < 0) {
      this.dropPage()
      return
    }
    const numeric = pocsagNumeric(this.bits)
    const alpha = printable(pocsagChars(this.bits))
    const isNumeric = this.func === 0
    const empty = this.bits.length === 0
    const m: PagerMessage = {
      id: `pocsag-${this.baud}-${Date.now()}-${this.seq++}`,
      at: Date.now(),
      proto: 'pocsag',
      baud: this.baud,
      levels: 2,
      address: this.address,
      func: this.func,
      kind: empty ? 'tone' : isNumeric ? 'numeric' : 'alpha',
      text: empty ? '' : isNumeric ? numeric : alpha,
      corrected: this.corrected,
    }
    if (!empty) m.alt = isNumeric ? alpha : numeric
    if (lost || this.damaged) m.partial = true
    this.dropPage()
    this.pending.push(m)
  }
}

// ---------------------------------------------------------------------------
// encoder, for demo mode and for testing the decoder against known pages
// ---------------------------------------------------------------------------

export interface PocsagPage {
  address: number
  func: number
  /** Digits for a numeric page, text for an alphanumeric one. Empty for tone only. */
  text: string
  numeric?: boolean
}

const DIGIT_CODE: Record<string, number> = Object.fromEntries(
  [...DIGITS].map((c, i) => [c, i]),
)

function bodyBits(page: PocsagPage): number[] {
  const bits: number[] = []
  if (page.numeric) {
    for (const ch of page.text) {
      const v = DIGIT_CODE[ch] ?? 0xc
      for (let b = 0; b < 4; b++) bits.push((v >> b) & 1)
    }
    while (bits.length % 20) bits.push(...[0, 0, 1, 1])
  } else {
    for (const ch of page.text) {
      const v = ch.charCodeAt(0) & 0x7f
      for (let b = 0; b < 7; b++) bits.push((v >> b) & 1)
    }
    // an end of text character, then zeros to the codeword boundary.
    for (let b = 0; b < 7; b++) bits.push((0x03 >> b) & 1)
    while (bits.length % 20) bits.push(0)
  }
  return bits
}

/** The bits of a whole POCSAG transmission, preamble first. */
export function pocsagTransmission(pages: PocsagPage[], preambleBits = 576): number[] {
  const words: number[] = []
  for (const page of pages) {
    const frame = page.address & 7
    // idle until the page's frame comes round in the current batch.
    while (words.length % BATCH_WORDS !== frame * 2) words.push(POCSAG_IDLE)
    words.push(pocsagEncode((((page.address >>> 3) & 0x3ffff) << 2) | (page.func & 3)))
    const bits = page.text ? bodyBits(page) : []
    for (let i = 0; i < bits.length; i += 20) {
      let d = 1 << 20
      for (let b = 0; b < 20; b++) d |= bits[i + b] << (19 - b)
      words.push(pocsagEncode(d))
    }
  }
  words.push(POCSAG_IDLE)
  while (words.length % BATCH_WORDS) words.push(POCSAG_IDLE)

  const out: number[] = []
  for (let i = 0; i < preambleBits; i++) out.push(i & 1 ? 0 : 1)
  for (let w = 0; w < words.length; w++) {
    if (w % BATCH_WORDS === 0) pushWord(out, POCSAG_SYNC)
    pushWord(out, words[w])
  }
  return out
}

function pushWord(out: number[], w: number): void {
  for (let b = 31; b >= 0; b--) out.push((w >>> b) & 1)
}

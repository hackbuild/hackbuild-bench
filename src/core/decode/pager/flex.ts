/**
 * FLEX, Motorola's synchronous paging code.
 *
 * Time is cut into 1.875 s frames, 128 to a cycle and 15 cycles to the hour.
 * Every frame opens at 1600 symbols a second with a bit sync, a 64 bit sync
 * word whose outer sixteen bits name the mode, and the frame information
 * word with the cycle and frame numbers. Then the rest switches to the
 * mode's rate: 25 ms of second sync and 1.76 s of data.
 *
 *   mode    symbols/s  levels  phases
 *   1600/2  1600       2       A
 *   3200/2  3200       2       A C
 *   3200/4  1600       4       A B
 *   6400/4  3200       4       A B C D
 *
 * A four level symbol carries a bit for two phases, gray coded, and at 3200
 * symbols a second alternate symbols belong to different phases. Each phase
 * is 11 blocks of 8 words, interleaved so the first bits of all eight words
 * go out before the second bits of any, which spreads a burst of noise over
 * eight codewords that can each correct two bits.
 *
 * Inside a phase the first word is the block information word, which says
 * where the address field and the vector field start. Each address has a
 * vector saying what the page is and where its words sit. Words are
 * BCH(31,21) sent least significant bit first, so data is the low 21 bits.
 */

import { bchCorrect31, flexCorrect, flexEncode, reverse31 } from './bch'
import type { PagerKind, PagerMessage } from './types'

/** The middle 32 bits of every sync word. */
const SYNC_MARKER = 0xa6c6aaaa
/** What follows the 64 bit sync window and precedes the frame information word. */
const SYNC_TAIL = 0x5939

export interface FlexMode {
  code: number
  /** Bits per second, the number paging people quote. */
  bps: number
  symbolRate: number
  levels: 2 | 4
}

export const FLEX_MODES: FlexMode[] = [
  { code: 0x870c, bps: 1600, symbolRate: 1600, levels: 2 },
  { code: 0x7b18, bps: 3200, symbolRate: 3200, levels: 2 },
  { code: 0xb068, bps: 3200, symbolRate: 1600, levels: 4 },
  { code: 0xdea0, bps: 6400, symbolRate: 3200, levels: 4 },
  // reflex uses the 6400/4 physical layer under its own code.
  { code: 0x4c7c, bps: 6400, symbolRate: 3200, levels: 4 },
]

const PHASE_WORDS = 88
const FIW_SKIP = 16
const SYNC2_MS = 25
const DATA_MS = 1760
const TEMP_FIRST = 2029568
const TEMP_LAST = 2029583
/** Frames a first fragment waits for the rest before it is shown alone. */
const FRAGMENT_FRAMES = 32
/** The highest capcode the address space has. */
const MAX_CAPCODE = 4297068542

/** Numeric digits by value. 0xc is a space, and also the fill after the last digit. */
const BCD = '0123456789.U -]['

function popcount(v: number): number {
  let n = 0
  for (let x = v >>> 0; x; x &= x - 1) n++
  return n
}

/** FLEX's four bit check over a 21 bit word: its nibbles sum to 0xf. */
export function flexChecksumOk(w: number): boolean {
  const s = (w & 0xf) + ((w >> 4) & 0xf) + ((w >> 8) & 0xf) + ((w >> 12) & 0xf) + ((w >> 16) & 0xf) + ((w >> 20) & 1)
  return (s & 0xf) === 0xf
}

/** Sets the low nibble so the word passes flexChecksumOk. */
export function withChecksum(w: number): number {
  const body = w & 0x1ffff0
  const s = ((body >> 4) & 0xf) + ((body >> 8) & 0xf) + ((body >> 12) & 0xf) + ((body >> 16) & 0xf) + ((body >> 20) & 1)
  return body | ((0xf - (s & 0xf)) & 0xf)
}

function modeFor(code: number): FlexMode | null {
  for (const m of FLEX_MODES) if (popcount((m.code ^ code) & 0xffff) < 4) return m
  return null
}

interface Phase {
  words: Uint32Array
  /** How sure each bit was, word * 32 + bit, from the symbol's distance to its threshold. */
  sure: Float32Array
}

interface GroupSlot {
  members: number[]
  /** Absolute frame, cycle * 128 + frame, the group page is due in. */
  due: number
}

interface Fragment {
  text: string
  address: number
  started: number
  corrected: number
  partial: boolean
  group?: number[]
}

export interface FlexStats {
  frames: number
  corrected: number
  uncorrectable: number
}

type State = 'hunt' | 'fiw' | 'sync2' | 'data'

/**
 * The frame layer. Symbols 0 to 3 go in, lowest frequency first, and the
 * slicer reads `symbolRate` after every one, since the rate changes inside
 * a frame.
 */
export class FlexFramer {
  onMessage: ((m: PagerMessage) => void) | null = null
  readonly stats: FlexStats = { frames: 0, corrected: 0, uncorrectable: 0 }
  symbolRate = 1600
  /** Levels the slicer should decide between for the current part of the frame. */
  levels: 2 | 4 = 2
  /** True from a sync word to the end of its frame, so the slicer holds its levels. */
  inFrame = false
  mode: FlexMode | null = null
  cycle = 0
  frame = 0

  private state: State = 'hunt'
  private hi = 0
  private lo = 0
  private inverted = false
  private count = 0
  private fiw = 0
  private phases: Phase[] = []
  private dataBits = 0
  private toggle = 0
  private seq = 0
  private groups = new Map<number, GroupSlot>()
  private fragments = new Map<string, Fragment>()

  reset(): void {
    this.state = 'hunt'
    this.hi = this.lo = 0
    this.endFrame()
    this.groups.clear()
    this.fragments.clear()
  }

  /**
   * `soft` is the symbol's average over the outer level, +1 at the top tone
   * and -1 at the bottom. It lets a word the code cannot fix be retried with
   * its least certain bits flipped.
   */
  push(sym: number, soft = 0): void {
    switch (this.state) {
      case 'hunt':
        this.hunt(sym)
        break
      case 'fiw': {
        const s = this.inverted ? 3 - sym : sym
        this.count++
        if (this.count <= FIW_SKIP) break
        this.fiw = ((this.fiw >>> 1) | (s > 1 ? 0x80000000 : 0)) >>> 0
        if (this.count === FIW_SKIP + 32) this.frameInfo()
        break
      }
      case 'sync2':
        if (++this.count >= (this.symbolRate * SYNC2_MS) / 1000) {
          this.state = 'data'
          this.count = 0
          this.levels = this.mode?.levels ?? 2
          this.phases = [0, 1, 2, 3].map(() => ({
            words: new Uint32Array(PHASE_WORDS),
            sure: new Float32Array(PHASE_WORDS * 32),
          }))
          this.dataBits = 0
          this.toggle = 0
        }
        break
      case 'data':
        this.data(this.inverted ? 3 - sym : sym, this.inverted ? -soft : soft)
        if (++this.count >= (this.symbolRate * DATA_MS) / 1000) this.decodeFrame()
        break
    }
  }

  private hunt(sym: number): void {
    const bit = sym < 2 ? 1 : 0
    this.hi = ((this.hi << 1) | (this.lo >>> 31)) >>> 0
    this.lo = ((this.lo << 1) | bit) >>> 0
    for (const inv of [false, true]) {
      const hi = inv ? ~this.hi >>> 0 : this.hi
      const lo = inv ? ~this.lo >>> 0 : this.lo
      const marker = ((hi << 16) | (lo >>> 16)) >>> 0
      if (popcount(marker ^ SYNC_MARKER) >= 4) continue
      const codeHigh = hi >>> 16
      const codeLow = ~lo & 0xffff
      if (popcount(codeHigh ^ codeLow) >= 4) continue
      const mode = modeFor(codeHigh)
      if (!mode) continue
      this.mode = mode
      this.inverted = inv
      this.state = 'fiw'
      this.inFrame = true
      this.count = 0
      this.fiw = 0
      return
    }
  }

  private frameInfo(): void {
    const fixed = flexCorrect(this.fiw)
    const w = fixed.word & 0x1fffff
    if (fixed.errors < 0 || !flexChecksumOk(w) || !this.mode) {
      this.endFrame()
      return
    }
    this.cycle = (w >> 4) & 0xf
    this.frame = (w >> 8) & 0x7f
    this.stats.frames++
    this.expire()
    this.state = 'sync2'
    this.count = 0
    this.symbolRate = this.mode.symbolRate
  }

  private data(sym: number, soft: number): void {
    const mode = this.mode
    if (!mode) return
    const a = sym > 1 ? 1 : 0
    const b = sym === 1 || sym === 2 ? 1 : 0
    const k = this.dataBits
    const idx = ((k >> 5) & ~7) | (k & 7)
    if (idx < PHASE_WORDS) {
      const first = this.toggle === 0 ? 0 : 2
      const pa = this.phases[first]
      const pb = this.phases[first + 1]
      pa.words[idx] = ((pa.words[idx] >>> 1) | (a << 31)) >>> 0
      pb.words[idx] = ((pb.words[idx] >>> 1) | (b << 31)) >>> 0
      const at = idx * 32 + ((k >> 3) & 31)
      pa.sure[at] = Math.abs(soft)
      pb.sure[at] = Math.abs(Math.abs(soft) - INNER_THRESHOLD)
    }
    if (mode.symbolRate === 3200) {
      this.toggle ^= 1
      if (this.toggle === 0) this.dataBits++
    } else {
      this.dataBits++
    }
  }

  private endFrame(): void {
    this.state = 'hunt'
    this.inFrame = false
    this.symbolRate = 1600
    this.levels = 2
    this.count = 0
  }

  private decodeFrame(): void {
    const mode = this.mode
    this.endFrame()
    if (!mode) return
    const names = mode.symbolRate === 1600 ? (mode.levels === 2 ? 'A' : 'AB') : mode.levels === 2 ? 'AC' : 'ABCD'
    for (const name of names) this.decodePhase(name, this.phases['ABCD'.indexOf(name)], mode)
  }

  /** Drops group assignments and fragments whose frame has gone by. */
  private expire(): void {
    const now = this.cycle * 128 + this.frame
    for (const [bit, slot] of this.groups) {
      const late = (now - slot.due + 2048) % 2048
      if (late > 0 && late < 1024) this.groups.delete(bit)
    }
    for (const [key, f] of this.fragments) {
      const age = (now - f.started + 2048) % 2048
      if (age > FRAGMENT_FRAMES) {
        this.fragments.delete(key)
        this.emit({ address: f.address, kind: 'alpha', func: 5, text: f.text, partial: true, corrected: f.corrected, group: f.group }, '?')
      }
    }
  }

  private decodePhase(name: string, ph: Phase, mode: FlexMode): void {
    const raw = ph.words
    const words = new Uint32Array(PHASE_WORDS)
    const bad = new Uint8Array(PHASE_WORDS)
    const errs = new Uint8Array(PHASE_WORDS)
    // a word chase fixed has no check of its own, so a page whose address or
    // vector came from one is shown flagged. message words have the K check.
    const guessed = new Uint8Array(PHASE_WORDS)
    for (let i = 0; i < PHASE_WORDS; i++) {
      let fixed = flexCorrect(raw[i])
      if (fixed.errors < 0) {
        fixed = chase(raw[i], ph.sure, i * 32)
        guessed[i] = 1
      }
      if (fixed.errors < 0) {
        bad[i] = 1
        this.stats.uncorrectable++
      } else {
        words[i] = fixed.word & 0x1fffff
        errs[i] = fixed.errors
        if (fixed.errors > 0) this.stats.corrected++
      }
    }
    if (bad[0] || guessed[0]) return
    const biw = words[0]
    if (biw === 0 || biw === 0x1fffff || !flexChecksumOk(biw)) return
    const aStart = ((biw >> 8) & 3) + 1
    const vStart = (biw >> 10) & 0x3f
    if (vStart < aStart || vStart + (vStart - aStart) > PHASE_WORDS) return

    for (let i = aStart; i < vStart; i++) {
      if (bad[i]) continue
      const aw = words[i]
      if (aw === 0 || aw === 0x1fffff) continue
      const j = vStart + (i - aStart)
      // these ranges only ever follow a long address's first word.
      if (aw >= 0x1e0001 && aw <= 0x1f0000) continue
      const isLong = (aw >= 0x1 && aw <= 0x8000) || (aw >= 0x1f7fff && aw <= 0x1ffffe)
      let capcode = aw - 0x8000
      if (isLong) {
        if (i + 1 >= vStart || bad[i + 1]) {
          i++
          continue
        }
        capcode = longCapcode(aw, words[i + 1])
        if (capcode < 0) {
          i++
          continue
        }
      }
      if (capcode <= 0 || capcode > MAX_CAPCODE || j >= PHASE_WORDS || bad[j] || !flexChecksumOk(words[j])) {
        if (isLong) i++
        continue
      }
      const viw = words[j]
      const doubt = Boolean(guessed[i] || guessed[j] || (isLong && (guessed[i + 1] || guessed[j + 1])))
      this.page(name, words, bad, errs, capcode, isLong, j, viw, mode, doubt)
      if (isLong) i++
    }
  }

  private page(
    phase: string,
    words: Uint32Array,
    bad: Uint8Array,
    errs: Uint8Array,
    capcode: number,
    isLong: boolean,
    j: number,
    viw: number,
    mode: FlexMode,
    doubt: boolean,
  ): void {
    const type = (viw >> 4) & 7
    const temp = capcode >= TEMP_FIRST && capcode <= TEMP_LAST

    if (type === 1) {
      // short instruction: a temporary address assignment for a group page.
      if ((viw >> 7) & 7) return
      const due = (viw >> 10) & 0x7f
      const bit = (viw >> 17) & 0xf
      let at = (this.cycle * 128 + due) % 2048
      if (due <= this.frame) at = (at + 128) % 2048
      const slot = this.groups.get(bit)
      if (slot && slot.due === at) slot.members.push(capcode)
      else this.groups.set(bit, { members: [capcode], due: at })
      return
    }

    let group: number[] | undefined
    if (temp) {
      const slot = this.groups.get(capcode - TEMP_FIRST)
      group = slot ? slot.members.slice() : []
      this.groups.delete(capcode - TEMP_FIRST)
    }

    const base = { address: capcode, func: type, group, phase, doubt }

    if (type === 2) {
      // short message: three numeric digits, or a tone with no body.
      const kind = (viw >> 7) & 3
      let text = ''
      if (kind === 0) {
        for (let s = 9; s <= 17; s += 4) text += BCD[(viw >> s) & 0xf]
        if (isLong && j + 1 < PHASE_WORDS && !bad[j + 1]) {
          for (let s = 0; s <= 16; s += 4) text += BCD[(words[j + 1] >> s) & 0xf]
        }
      }
      this.emit({ ...base, kind: 'tone', text: text.trim(), corrected: errs[j] }, mode)
      return
    }

    if (type === 3 || type === 4 || type === 7) {
      this.numeric(base, words, bad, errs, isLong, j, viw, type, mode)
      return
    }

    if (type === 0 || type === 5) {
      this.alpha(base, words, bad, errs, isLong, j, viw, mode)
      return
    }

    // binary, shown as hex words.
    const start = (viw >> 7) & 0x7f
    const len = (viw >> 14) & 0x7f
    let text = ''
    let corrected = errs[j]
    for (let w = start; w < start + len && w < PHASE_WORDS; w++) {
      text += (bad[w] ? '??????' : words[w].toString(16).padStart(6, '0')) + ' '
      corrected += errs[w]
    }
    this.emit({ ...base, kind: 'binary', text: text.trim(), corrected }, mode)
  }

  private numeric(
    base: { address: number; func: number; group?: number[]; phase: string; doubt: boolean },
    words: Uint32Array,
    bad: Uint8Array,
    errs: Uint8Array,
    isLong: boolean,
    j: number,
    viw: number,
    type: number,
    mode: FlexMode,
  ): void {
    const start = (viw >> 7) & 0x7f
    const extra = (viw >> 14) & 7
    const list: number[] = isLong ? [j + 1] : []
    for (let w = start; w <= start + extra - (isLong ? 1 : 0); w++) list.push(w)
    let digit = 0
    let count = type === 7 ? 14 : 6
    let text = ''
    let corrected = errs[j]
    let partial = false
    let kSum = 0
    for (const [n, w] of list.entries()) {
      if (w >= PHASE_WORDS || bad[w]) {
        partial = true
        continue
      }
      corrected += errs[w]
      // the first word's low two bits are the top of the six bit check.
      kSum += sumBytes(n === 0 ? words[w] & ~3 : words[w])
      let dw = words[w]
      for (let k = 0; k < 21; k++) {
        digit = (digit >> 1) & 0xf
        if (dw & 1) digit ^= 8
        dw >>= 1
        if (--count === 0) {
          text += BCD[digit]
          count = 4
        }
      }
    }
    if (!partial && list.length) {
      const k = (((words[list[0]] & 3) << 4) | ((viw >> 17) & 0xf)) >>> 0
      if (numericCheck(kSum) !== k) partial = true
    }
    this.emit({ ...base, kind: 'numeric', text: text.trimEnd(), corrected, partial }, mode)
  }

  private alpha(
    base: { address: number; func: number; group?: number[]; phase: string; doubt: boolean },
    words: Uint32Array,
    bad: Uint8Array,
    errs: Uint8Array,
    isLong: boolean,
    j: number,
    viw: number,
    mode: FlexMode,
  ): void {
    const start = (viw >> 7) & 0x7f
    const len = (viw >> 14) & 0x7f
    // a short address's header is the first message word. a long address
    // spends its second vector word on it instead.
    const headerAt = isLong ? j + 1 : start
    const first = isLong ? start : start + 1
    const count = len - 1
    if (headerAt >= PHASE_WORDS || bad[headerAt] || count < 0) return
    const header = words[headerAt]
    const cont = (header >> 10) & 1
    const frag = (header >> 11) & 3
    const number = (header >> 13) & 0x3f
    const initial = frag === 3

    const codes: number[] = []
    let corrected = errs[j] + errs[headerAt]
    let partial = false
    // the header's low ten bits are the ones complement of the sum of every
    // word's bytes, header included with those bits zeroed. it catches the
    // words two bit correction got wrong, which a weak signal produces.
    let kSum = sumBytes(header & ~0x3ff)
    let signature = -1
    let charSum = 0
    for (let n = 0; n < count; n++) {
      const w = first + n
      if (w >= PHASE_WORDS || bad[w]) {
        partial = true
        codes.push(0x3f, 0x3f, 0x3f)
        continue
      }
      corrected += errs[w]
      const dw = words[w]
      kSum += sumBytes(dw)
      const chars = n === 0 && initial ? [(dw >> 7) & 0x7f, (dw >> 14) & 0x7f] : [dw & 0x7f, (dw >> 7) & 0x7f, (dw >> 14) & 0x7f]
      if (n === 0 && initial) signature = dw & 0x7f
      for (const c of chars) {
        codes.push(c)
        if (c !== 0x03) charSum += c
      }
    }
    if (!partial && (~kSum & 0x3ff) !== (header & 0x3ff)) partial = true
    if (!partial && initial && cont === 0 && signature >= 0 && (~charSum & 0x7f) !== signature) partial = true
    let text = ''
    for (const c of codes) {
      if (c >= 0x20 && c < 0x7f) text += String.fromCharCode(c)
      else if (c === 0x0a || c === 0x0d) text += ' '
    }

    const key = `${base.address}:${number}`
    const held = this.fragments.get(key)
    if (cont === 1) {
      if (held && !initial) {
        held.text += text
        held.corrected += corrected
        held.partial ||= partial || base.doubt
      } else {
        this.fragments.set(key, {
          text,
          address: base.address,
          started: this.cycle * 128 + this.frame,
          corrected,
          partial: partial || base.doubt,
          group: base.group,
        })
      }
      return
    }
    if (held && !initial) {
      this.fragments.delete(key)
      this.emit(
        { ...base, group: held.group ?? base.group, kind: 'alpha', text: (held.text + text).trimEnd(), corrected: held.corrected + corrected, partial: held.partial || partial },
        mode,
      )
      return
    }
    // a continuation whose start was never heard.
    this.emit({ ...base, kind: 'alpha', text: text.trimEnd(), corrected, partial: partial || !initial }, mode)
  }

  private emit(
    m: { address: number; func: number; kind: PagerKind; text: string; corrected: number; partial?: boolean; doubt?: boolean; group?: number[]; phase?: string },
    mode: FlexMode | '?',
  ): void {
    const md = mode === '?' ? this.mode : mode
    const out: PagerMessage = {
      id: `flex-${Date.now()}-${this.seq++}`,
      at: Date.now(),
      proto: 'flex',
      baud: md?.bps ?? 1600,
      levels: md?.levels ?? 2,
      address: m.address,
      func: m.func,
      kind: m.kind,
      text: m.text,
      cycle: this.cycle,
      frame: this.frame,
      corrected: m.corrected,
    }
    if (m.phase) out.phase = m.phase
    if (m.group) out.group = m.group
    if (m.partial || m.doubt) out.partial = true
    this.onMessage?.(out)
  }
}

/** Where the inner levels of four level FSK split from the outer, as a share of the outer. */
const INNER_THRESHOLD = 2 / 3
/** Least certain bits a failed word is retried with flipped. */
const CHASE_BITS = 5

function parity32(v: number): number {
  let p = 0
  for (let x = v >>> 0; x; x &= x - 1) p ^= 1
  return p
}

/**
 * Retries a word the code could not fix, flipping one or two of its least
 * certain bits first. The fix with the least total certainty spent wins.
 * At most three bits change in all, and the even parity bit has to agree,
 * so this reaches one error past the code without guessing freely.
 */
function chase(word: number, sure: Float32Array, at: number): { word: number; errors: number } {
  const order = Array.from({ length: 32 }, (_, b) => b).sort((x, y) => sure[at + x] - sure[at + y])
  const weak = order.slice(0, CHASE_BITS)
  const tries: number[][] = []
  for (let x = 0; x < weak.length; x++) {
    tries.push([weak[x]])
    for (let y = x + 1; y < weak.length; y++) tries.push([weak[x], weak[y]])
  }
  let best = { word, errors: -1 }
  let bestCost = Infinity
  for (const flips of tries) {
    let w = word
    let cost = 0
    for (const b of flips) {
      w = (w ^ (1 << b)) >>> 0
      cost += sure[at + b]
    }
    const fixed = bchCorrect31(reverse31(w & 0x7fffffff))
    if (fixed.errors < 0 || flips.length + fixed.errors > 3) continue
    const word31 = reverse31(fixed.word)
    if (parity32(word31) !== (w >>> 31)) continue
    const changed = (word31 ^ (w & 0x7fffffff)) >>> 0
    for (let b = 0; b < 31; b++) if (changed & (1 << b)) cost += sure[at + b]
    if (cost < bestCost) {
      bestCost = cost
      best = { word: word31, errors: flips.length + fixed.errors }
    }
  }
  return best
}

function sumBytes(w: number): number {
  return (w & 0xff) + ((w >> 8) & 0xff) + ((w >> 16) & 0x1f)
}

/** A numeric page's six bit check from the byte sum of its words. */
function numericCheck(sum: number): number {
  const s = sum & 0xff
  return ~((s & 0x3f) + (s >> 6)) & 0x3f
}

/** A capcode from two long address words, per the address sets FLEX defines. */
function longCapcode(w1: number, w2: number): number {
  if (w1 >= 1 && w1 <= 32768 && w2 >= 2064383 && w2 <= 2097150) {
    return w1 + (2097151 - w2) * 32768 + 2068480
  }
  if (w1 >= 1 && w1 <= 32768 && w2 >= 1966081 && w2 <= 2031616) {
    return w1 + (w2 - 1933312) * 32768 + 2068480
  }
  if (w1 >= 2064383 && w1 <= 2097150 && w2 >= 1966081 && w2 <= 2031616) {
    return w1 - 2064383 + (w2 - 1867776) * 32768 + 2068479
  }
  return -1
}

// ---------------------------------------------------------------------------
// encoder, for demo mode and for testing the decoder against known pages
// ---------------------------------------------------------------------------

export interface FlexPage {
  capcode: number
  text: string
  numeric?: boolean
  /** Which phase carries it. A unless the mode has more. */
  phase?: 'A' | 'B' | 'C' | 'D'
}

function alphaWords(text: string, number: number): number[] {
  const chars = [...text].map((c) => c.charCodeAt(0) & 0x7f)
  let sig = 0
  for (const c of chars) sig += c
  const slots = [(~sig) & 0x7f, ...chars]
  while (slots.length % 3) slots.push(0x03)
  const body: number[] = []
  for (let i = 0; i < slots.length; i += 3) body.push(slots[i] | (slots[i + 1] << 7) | (slots[i + 2] << 14))
  let header = (3 << 11) | ((number & 0x3f) << 13)
  let sum = 0
  for (const w of [header, ...body]) sum += (w & 0xff) + ((w >> 8) & 0xff) + ((w >> 16) & 0x1f)
  header |= ~sum & 0x3ff
  return [header, ...body]
}

function numericWords(text: string): number[] {
  const bits: number[] = [0, 0]
  for (const ch of text) {
    const v = BCD.indexOf(ch)
    const d = v < 0 ? 0xc : v
    for (let b = 0; b < 4; b++) bits.push((d >> b) & 1)
  }
  while (bits.length % 21) bits.push(...[0, 0, 1, 1].slice(0, Math.min(4, 21 - (bits.length % 21))))
  const words: number[] = []
  for (let i = 0; i < bits.length; i += 21) {
    let w = 0
    for (let b = 0; b < 21; b++) w |= (bits[i + b] ?? 0) << b
    words.push(w)
  }
  let sum = 0
  for (const w of words) sum += sumBytes(w)
  const k = numericCheck(sum)
  words[0] |= k >> 4
  return words
}

/** The low four bits of a numeric page's check, which ride in its vector. */
function numericVectorCheck(body: number[]): number {
  let sum = 0
  body.forEach((w, n) => (sum += sumBytes(n === 0 ? w & ~3 : w)))
  return numericCheck(sum) & 0xf
}

/** The 88 data words of one phase carrying these pages, short addresses only. */
export function flexPhaseWords(pages: FlexPage[]): number[] {
  const words = new Array<number>(PHASE_WORDS).fill(0)
  const n = pages.length
  const aStart = 1
  const vStart = aStart + n
  let next = vStart + n
  words[0] = withChecksum((vStart << 10) | ((aStart - 1) << 8))
  pages.forEach((p, i) => {
    words[aStart + i] = p.capcode + 0x8000
    const body = p.numeric ? numericWords(p.text) : alphaWords(p.text, i)
    const type = p.numeric ? 3 : 5
    const lenField = p.numeric ? body.length - 1 : body.length
    const k30 = p.numeric ? numericVectorCheck(body) << 17 : 0
    words[vStart + i] = withChecksum(k30 | (lenField << 14) | (next << 7) | (type << 4))
    for (const w of body) if (next < PHASE_WORDS) words[next++] = w
  })
  return words.map((w) => flexEncode(w))
}

function bitsMsb(value: number, n: number): number[] {
  const out: number[] = []
  for (let b = n - 1; b >= 0; b--) out.push(Math.floor(value / 2 ** b) % 2)
  return out
}

export interface FlexSymbols {
  /** Each symbol with the rate it goes out at. */
  symbols: number[]
  rates: number[]
}

/** One whole frame as symbols, 0 the lowest tone and 3 the highest. */
export function flexFrameSymbols(mode: FlexMode, cycle: number, frame: number, pages: FlexPage[]): FlexSymbols {
  const symbols: number[] = []
  const rates: number[] = []
  const at = (s: number, r: number) => {
    symbols.push(s)
    rates.push(r)
  }
  // sync sense: a 1 is the low tone.
  const syncBit = (b: number) => at(b ? 0 : 3, 1600)
  for (let i = 0; i < 32; i++) syncBit(i & 1 ? 0 : 1)
  for (const b of bitsMsb(mode.code, 16)) syncBit(b)
  for (const b of bitsMsb(SYNC_MARKER, 32)) syncBit(b)
  for (const b of bitsMsb(~mode.code & 0xffff, 16)) syncBit(b)
  for (const b of bitsMsb(SYNC_TAIL, 16)) syncBit(b)
  const fiw = flexEncode(withChecksum(((frame & 0x7f) << 8) | ((cycle & 0xf) << 4)))
  for (let b = 0; b < 32; b++) at((fiw >>> b) & 1 ? 3 : 0, 1600)

  const rate = mode.symbolRate
  for (let i = 0; i < (rate * SYNC2_MS) / 1000; i++) at(i & 1 ? 0 : 3, rate)

  const byPhase = (p: string) => flexPhaseWords(pages.filter((x) => (x.phase ?? 'A') === p))
  const ph = { A: byPhase('A'), B: byPhase('B'), C: byPhase('C'), D: byPhase('D') }
  const bitOf = (w: number[], k: number) => {
    const idx = ((k >> 5) & ~7) | (k & 7)
    return (w[idx] >>> ((k >> 3) & 31)) & 1
  }
  const symbolFor = (a: number, b: number) => (mode.levels === 2 ? (a ? 3 : 0) : a ? (b ? 2 : 3) : b ? 1 : 0)
  for (let k = 0; k < 2816; k++) {
    at(symbolFor(bitOf(ph.A, k), bitOf(ph.B, k)), rate)
    if (rate === 3200) at(symbolFor(bitOf(ph.C, k), bitOf(ph.D, k)), rate)
  }
  return { symbols, rates }
}

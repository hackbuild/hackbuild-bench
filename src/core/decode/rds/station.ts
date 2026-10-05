import type { RdsGroup } from './blocks'
import { PTY_RBDS, PTY_RDS, afToHz, callSignFromPi, rdsChar } from './tables'

/**
 * What one station has said about itself, built up group by group.
 *
 * Multi-group text only counts as received once every segment has arrived in
 * order since the start of the string, the same rule redsea applies, so a
 * name half overwritten by a different one is never shown as whole.
 */

const TERMINATOR = 0x0d
/**
 * A group whose second block was corrected across a longer burst than this is
 * dropped, since that block names the group type. At five bits more than a
 * third of all random words decode as some correctable error, so a long
 * correction is often a wrong one.
 */
const TRUSTED_BURST = 2

class SegmentedText {
  private data: number[]
  private known: boolean[]
  private pending = new Map<number, number>()
  private size: number
  private seq = 0
  private prev = -1
  last: string | null = null
  /** Whole reads, each counted as its final character lands. */
  reads = 0

  constructor(size: number) {
    this.size = size
    this.data = new Array<number>(size).fill(0x20)
    this.known = new Array<boolean>(size).fill(false)
  }

  resize(size: number): void {
    if (size === this.size) return
    this.size = size
    this.data = this.data.slice(0, size)
    this.known = this.known.slice(0, size)
    while (this.data.length < size) this.data.push(0x20)
    while (this.known.length < size) this.known.push(false)
    if (this.seq > size) this.seq = size
  }

  clear(): void {
    this.data.fill(0x20)
    this.known.fill(false)
    this.pending.clear()
    this.seq = 0
    this.prev = -1
  }

  get receivedLength(): number {
    return this.seq
  }

  get hasTerminator(): boolean {
    return this.data.includes(TERMINATOR)
  }

  private get expected(): number {
    const t = this.data.indexOf(TERMINATOR)
    return t < 0 ? this.size : Math.min(this.size, t + 1)
  }

  get complete(): boolean {
    return this.seq >= this.expected
  }

  /** A character from a block that may be a miscorrection waits for a second copy. */
  offer(pos: number, byte: number, weak: boolean): void {
    if (pos >= this.size) return
    const confirmed = (this.known[pos] && this.data[pos] === byte) || this.pending.get(pos) === byte
    if (weak && !confirmed) {
      this.pending.set(pos, byte)
      this.prev = -1
      return
    }
    this.pending.delete(pos)
    this.set(pos, byte)
  }

  private set(pos: number, byte: number): void {
    this.data[pos] = byte
    this.known[pos] = true
    if (pos === 0 || (pos === this.prev + 1 && this.seq === pos)) this.seq = pos + 1
    this.prev = pos
    if (this.complete) {
      this.last = this.text()
      if (pos === this.expected - 1) this.reads++
    }
  }

  /** Characters received in sequence so far, up to the terminator. */
  text(): string {
    let s = ''
    const n = Math.min(this.expected, this.seq)
    for (let i = 0; i < n; i++) {
      const b = this.data[i]
      if (b === TERMINATOR) break
      s += rdsChar(b)
    }
    return s
  }

  /** Every slot, received or not, for a partial display. */
  partial(): string {
    let s = ''
    for (let i = 0; i < this.size; i++) {
      const b = this.data[i]
      if (b === TERMINATOR) break
      s += rdsChar(b)
    }
    return s
  }
}

export interface RdsClock {
  /** UTC instant the station sent, in ms. */
  utcMs: number
  /** Local offset the station sent, in minutes east of UTC. */
  offsetMin: number
}

export type RdsEvent =
  | { type: 'pi'; pi: number }
  | { type: 'ps'; ps: string }
  | { type: 'rt'; rt: string }
  | { type: 'ct'; clock: RdsClock }
  | { type: 'pty'; pty: number }
  | { type: 'af'; afHz: number[] }

export interface RdsSnapshot {
  pi: number | null
  callSign: string | null
  callSignUncertain: boolean
  ps: string | null
  /** The name as far as it has arrived, with gaps as spaces. */
  psPartial: string
  rt: string | null
  rtPartial: string
  pty: number | null
  ptyName: string | null
  tp: boolean
  ta: boolean
  music: boolean | null
  clock: RdsClock | null
  afHz: number[]
  groups: number
  groupTypes: Record<string, number>
}

function trimEnd(s: string): string {
  return s.replace(/\s+$/, '')
}

/** Modified julian date to a UTC day, EN 50067 annex G. */
function mjdToUtcMs(mjd: number, hour: number, minute: number): number {
  return Date.UTC(1858, 10, 17) + mjd * 86_400_000 + hour * 3_600_000 + minute * 60_000
}

export class RdsStation {
  private piCode: number | null = null
  private piCandidate: number | null = null
  private ps = new SegmentedText(8)
  private rt = new SegmentedText(64)
  private rtAb: number | null = null
  private rtShownThisCycle = false
  private rtMaybe = ''
  private lastPs: string | null = null
  private psCandidate: string | null = null
  private psReads = 0
  private lastRt: string | null = null
  private ptyCode: number | null = null
  private ptyCandidate: number | null = null
  private tp = false
  private ta = false
  private music: boolean | null = null
  private clock: RdsClock | null = null
  private af = new Set<number>()
  private afSeen = new Map<number, number>()
  private lastGroupHadPi = false
  private groups = 0
  private groupTypes: Record<string, number> = {}

  /** North American names and call signs when true, IEC names otherwise. */
  rbds = true

  onEvent: (e: RdsEvent) => void = () => {}

  reset(): void {
    this.piCode = null
    this.piCandidate = null
    this.ps.clear()
    this.rt.clear()
    this.ps.last = null
    this.rt.last = null
    this.rtAb = null
    this.rtShownThisCycle = false
    this.rtMaybe = ''
    this.lastPs = null
    this.psCandidate = null
    this.psReads = 0
    this.lastRt = null
    this.ptyCode = null
    this.ptyCandidate = null
    this.tp = false
    this.ta = false
    this.music = null
    this.clock = null
    this.af.clear()
    this.afSeen.clear()
    this.lastGroupHadPi = false
    this.groups = 0
    this.groupTypes = {}
  }

  snapshot(): RdsSnapshot {
    const cs = this.piCode !== null && this.rbds ? callSignFromPi(this.piCode) : null
    const names = this.rbds ? PTY_RBDS : PTY_RDS
    return {
      pi: this.piCode,
      callSign: cs?.call ?? null,
      callSignUncertain: cs?.uncertain ?? false,
      ps: this.lastPs,
      psPartial: this.ps.partial(),
      rt: this.lastRt,
      rtPartial: trimEnd(this.rt.partial()),
      pty: this.ptyCode,
      ptyName: this.ptyCode === null ? null : names[this.ptyCode] ?? null,
      tp: this.tp,
      ta: this.ta,
      music: this.music,
      clock: this.clock,
      afHz: [...this.af].sort((a, b) => a - b),
      groups: this.groups,
      groupTypes: { ...this.groupTypes },
    }
  }

  push(g: RdsGroup): void {
    const [a, b, c, d] = g.blocks
    const bursts = g.bursts
    const versionB = b !== null ? (b >> 11) & 1 : g.cPrime ? 1 : 0
    const pi = a ?? (versionB && c !== null ? c : null)

    // one group without a PI is allowed, the second in a row is dropped.
    if (pi !== null) this.lastGroupHadPi = true
    else if (this.lastGroupHadPi) this.lastGroupHadPi = false
    else return

    if (pi !== null) this.takePi(pi)
    // the group type and every flag live in block 2, so nothing else in a
    // group is believed when that block is in doubt.
    if (b === null || bursts[1] > TRUSTED_BURST) return

    this.groups++
    const type = b >> 12
    const name = `${type}${versionB ? 'B' : 'A'}`
    this.groupTypes[name] = (this.groupTypes[name] ?? 0) + 1

    this.tp = ((b >> 10) & 1) === 1
    const pty = (b >> 5) & 0x1f
    if (pty !== this.ptyCode && pty === this.ptyCandidate) {
      this.ptyCode = pty
      this.onEvent({ type: 'pty', pty })
    }
    this.ptyCandidate = pty

    // any correction in the block carrying text, or in the block carrying
    // its position, holds that text back until a second copy agrees.
    const weakC = bursts[1] > 0 || bursts[2] > 0
    const weakD = bursts[1] > 0 || bursts[3] > 0
    if (type === 0) this.group0(versionB, b, bursts[2] > 0 ? null : c, d, weakD)
    else if (type === 2) this.group2(versionB, b, c, d, weakC || weakD)
    else if (type === 4 && !versionB && bursts[2] <= TRUSTED_BURST && bursts[3] <= TRUSTED_BURST) {
      this.group4a(b, c, d)
    }
  }

  private takePi(pi: number): void {
    if (pi === this.piCode) return
    // a new code is taken only once two groups agree on it.
    if (this.piCandidate === pi) {
      const changed = this.piCode !== null
      this.piCode = pi
      if (changed) {
        const keep = this.groups
        this.reset()
        this.groups = keep
        this.piCode = pi
      }
      this.onEvent({ type: 'pi', pi })
    } else {
      this.piCandidate = pi
      if (this.piCode === null) return
    }
  }

  private group0(versionB: number, b: number, c: number | null, d: number | null, weakD: boolean): void {
    this.ta = ((b >> 4) & 1) === 1
    this.music = ((b >> 3) & 1) === 1
    const seg = b & 3
    if (!versionB && c !== null) {
      let added = false
      for (const code of [c >> 8, c & 0xff]) {
        const hz = afToHz(code)
        if (hz === null || this.af.has(hz)) continue
        // a frequency is listed once it has been heard twice.
        const seen = (this.afSeen.get(hz) ?? 0) + 1
        this.afSeen.set(hz, seen)
        if (seen >= 2) {
          this.af.add(hz)
          added = true
        }
      }
      if (added) this.onEvent({ type: 'af', afHz: [...this.af].sort((x, y) => x - y) })
    }
    if (d === null) return
    this.ps.offer(seg * 2, d >> 8, weakD)
    this.ps.offer(seg * 2 + 1, d & 0xff, weakD)
    // stations scroll text through the name a word at a time, and a lost
    // segment then splices two words into one whole looking name. a name is
    // shown once two whole reads in a row agree on it.
    if (this.ps.reads !== this.psReads && this.ps.last !== null) {
      this.psReads = this.ps.reads
      const read = this.ps.last
      if (read === this.psCandidate && read !== this.lastPs) {
        this.lastPs = read
        this.onEvent({ type: 'ps', ps: read })
      }
      this.psCandidate = read
    }
  }

  private group2(versionB: number, b: number, c: number | null, d: number | null, weak: boolean): void {
    if (c === null || d === null) return
    const seg = b & 0xf
    const pos = seg * (versionB ? 2 : 4)
    const ab = (b >> 4) & 1

    // a station sending no terminator repeats the same text, so a repeat
    // seen from the start counts as the whole message.
    let maybe: string | null = null
    if (pos === 0 && this.rt.receivedLength > 1 && !this.rt.complete && !this.rt.hasTerminator) {
      const candidate = trimEnd(this.rt.text())
      if (candidate === this.rtMaybe) maybe = candidate
      this.rtMaybe = candidate
    }
    if (pos === 0) this.rtShownThisCycle = false
    if (this.rtAb !== null && ab !== this.rtAb) {
      this.rt.clear()
      this.rtShownThisCycle = false
    }
    this.rtAb = ab

    if (!versionB) {
      this.rt.resize(64)
      this.rt.offer(pos, c >> 8, weak)
      this.rt.offer(pos + 1, c & 0xff, weak)
      this.rt.offer(pos + 2, d >> 8, weak)
      this.rt.offer(pos + 3, d & 0xff, weak)
    } else {
      this.rt.resize(32)
      this.rt.offer(pos, d >> 8, weak)
      this.rt.offer(pos + 1, d & 0xff, weak)
    }

    let text: string | null = null
    if (this.rt.complete && this.rt.last !== null) text = trimEnd(this.rt.last)
    else if (maybe) text = maybe
    if (text !== null && !this.rtShownThisCycle) {
      this.rtShownThisCycle = true
      if (text !== this.lastRt) {
        this.lastRt = text
        this.onEvent({ type: 'rt', rt: text })
      }
    }
  }

  private group4a(b: number, c: number | null, d: number | null): void {
    if (c === null || d === null) return
    const mjd = ((b & 3) << 15) | (c >> 1)
    const hour = ((c & 1) << 4) | (d >> 12)
    const minute = (d >> 6) & 0x3f
    const offset = ((d >> 5) & 1 ? -1 : 1) * (d & 0x1f) * 30
    if (mjd < 15079 || hour > 23 || minute > 59 || Math.abs(offset) > 14 * 60) return
    this.clock = { utcMs: mjdToUtcMs(mjd, hour, minute), offsetMin: offset }
    this.onEvent({ type: 'ct', clock: this.clock })
  }
}

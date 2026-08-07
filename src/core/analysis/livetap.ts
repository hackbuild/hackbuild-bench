/**
 * A rolling analysis window over a live byte stream.
 *
 * The tap is push driven and holds one fixed allocation. Nothing here grows
 * with stream length, so a serial port running for an hour costs the same as
 * one running for a second.
 */

import { detectChecksum } from '@/core/analysis/metrics'
import type { ChecksumHit } from '@/core/analysis/metrics'

export type StructureKind = 'fixed-frame' | 'delimiter' | 'length-prefix'

export interface StructureHint {
  kind: StructureKind
  /** Frame length, delimiter byte, or prefix offset, depending on kind. */
  value: number
  detail: string
  confidence: number
}

export interface LiveTapSnapshot {
  /** Bytes seen since the last reset, not just the ones still in the window. */
  total: number
  /** Bytes currently held. */
  window: number
  capacity: number
  entropy: number
  /** Recent entropy readings, oldest first. */
  trend: number[]
  histogram: Uint32Array
  printable: number
  bytesPerSecond: number
  structure: StructureHint[]
  checksum: ChecksumHit | null
  frames: number
}

export interface LiveTapOptions {
  /** Rolling window size in bytes. */
  window?: number
  /** Entropy readings kept for the trend line. */
  trend?: number
  /** Bytes between entropy readings. */
  interval?: number
}

const PRINTABLE = (() => {
  const t = new Uint8Array(256)
  for (let b = 0; b < 256; b++) {
    t[b] = b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e) ? 1 : 0
  }
  return t
})()

export class LiveTap {
  private buf: Uint8Array
  private head = 0
  private filled = 0
  private hist = new Uint32Array(256)
  private printableCount = 0
  private trendRing: number[] = []
  private trendCap: number
  private interval: number
  private sinceReading = 0
  private seen = 0
  private startedAt = 0
  private lastAt = 0
  private cache: {
    seen: number
    delim: { byte: number; gap: number; confidence: number } | null
    period: { period: number; confidence: number } | null
  } | null = null

  constructor(opts: LiveTapOptions = {}) {
    this.buf = new Uint8Array(Math.max(256, opts.window ?? 4096))
    this.trendCap = Math.max(8, opts.trend ?? 96)
    this.interval = Math.max(64, opts.interval ?? 256)
  }

  get capacity(): number {
    return this.buf.length
  }

  /** Feed one chunk. Oldest bytes fall out of the window. */
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return
    const now = Date.now()
    if (this.startedAt === 0) this.startedAt = now
    this.lastAt = now
    this.seen += chunk.length

    const cap = this.buf.length
    // more than a window in one chunk: only the tail can survive anyway.
    const src = chunk.length > cap ? chunk.subarray(chunk.length - cap) : chunk

    for (let i = 0; i < src.length; i++) {
      if (this.filled === cap) {
        const evicted = this.buf[this.head]
        this.hist[evicted]--
        if (PRINTABLE[evicted]) this.printableCount--
      } else {
        this.filled++
      }
      const b = src[i]
      this.buf[this.head] = b
      this.head = (this.head + 1) % cap
      this.hist[b]++
      if (PRINTABLE[b]) this.printableCount++
    }

    this.sinceReading += src.length
    while (this.sinceReading >= this.interval) {
      this.sinceReading -= this.interval
      this.trendRing.push(this.windowEntropy())
      if (this.trendRing.length > this.trendCap) this.trendRing.shift()
    }
  }

  /**
   * Wire the tap to any push source. `subscribe` registers a chunk listener and
   * returns its own unsubscribe.
   */
  attach(subscribe: (onChunk: (chunk: Uint8Array) => void) => () => void): () => void {
    return subscribe((chunk) => this.push(chunk))
  }

  reset(): void {
    this.head = 0
    this.filled = 0
    this.hist.fill(0)
    this.printableCount = 0
    this.trendRing = []
    this.sinceReading = 0
    this.seen = 0
    this.startedAt = 0
    this.lastAt = 0
    this.cache = null
  }

  /** The window as a flat copy, oldest byte first. Hand this to the recipe. */
  freeze(): Uint8Array {
    const cap = this.buf.length
    const out = new Uint8Array(this.filled)
    const start = this.filled === cap ? this.head : 0
    for (let i = 0; i < this.filled; i++) out[i] = this.buf[(start + i) % cap]
    return out
  }

  snapshot(): LiveTapSnapshot {
    const window = this.freeze()
    const shape = this.shapeOf(window)
    const frames = this.splitFrames(window, shape)
    const elapsed = this.lastAt > this.startedAt ? (this.lastAt - this.startedAt) / 1000 : 0
    return {
      total: this.seen,
      window: this.filled,
      capacity: this.buf.length,
      entropy: this.windowEntropy(),
      trend: [...this.trendRing],
      histogram: this.hist.slice(),
      printable: this.filled === 0 ? 0 : this.printableCount / this.filled,
      bytesPerSecond: elapsed > 0 ? this.seen / elapsed : 0,
      structure: this.detectStructure(shape, frames),
      checksum: frames.length >= 2 ? detectChecksum(frames) : null,
      frames: frames.length,
    }
  }

  // -------------------------------------------------------------------------
  // structure
  // -------------------------------------------------------------------------

  private windowEntropy(): number {
    if (this.filled === 0) return 0
    let h = 0
    for (let i = 0; i < 256; i++) {
      const c = this.hist[i]
      if (c === 0) continue
      const p = c / this.filled
      h -= p * Math.log2(p)
    }
    return h
  }

  /**
   * Delimiter and period search are the expensive part of a snapshot, so the
   * result is kept until the next byte arrives. A panel polling at frame rate
   * over an idle port then costs nothing.
   */
  private shapeOf(window: Uint8Array): {
    delim: { byte: number; gap: number; confidence: number } | null
    period: { period: number; confidence: number } | null
  } {
    if (this.cache && this.cache.seen === this.seen) return this.cache
    const shape = {
      seen: this.seen,
      delim: this.bestDelimiter(window),
      period: this.bestPeriod(window),
    }
    this.cache = shape
    return shape
  }

  /** The delimiter with the most regular spacing, or null. */
  private bestDelimiter(window: Uint8Array): { byte: number; gap: number; confidence: number } | null {
    if (window.length < 32) return null
    const positions = new Map<number, number[]>()
    for (let i = 0; i < window.length; i++) {
      const b = window[i]
      if (this.hist[b] < 4 || this.hist[b] > window.length / 3) continue
      let list = positions.get(b)
      if (!list) {
        list = []
        positions.set(b, list)
      }
      list.push(i)
    }

    let best: { byte: number; gap: number; confidence: number } | null = null
    for (const [byte, list] of positions) {
      if (list.length < 4) continue
      const gaps = new Map<number, number>()
      for (let i = 1; i < list.length; i++) {
        const g = list[i] - list[i - 1]
        gaps.set(g, (gaps.get(g) ?? 0) + 1)
      }
      let modeGap = 0
      let modeCount = 0
      for (const [g, c] of gaps) {
        if (c > modeCount) {
          modeCount = c
          modeGap = g
        }
      }
      if (modeGap < 2) continue
      const regularity = modeCount / (list.length - 1)
      const confidence = regularity * Math.min(1, (list.length - 1) / 8)
      if (confidence >= 0.5 && (!best || confidence > best.confidence)) {
        best = { byte, gap: modeGap, confidence }
      }
    }
    return best
  }

  /** Smallest period where the window repeats itself byte for byte. */
  private bestPeriod(window: Uint8Array): { period: number; confidence: number } | null {
    const n = window.length
    if (n < 64) return null
    const limit = Math.min(256, Math.floor(n / 3))
    let best: { period: number; confidence: number } | null = null
    for (let p = 2; p <= limit; p++) {
      const span = n - p
      const stride = span > 1024 ? 2 : 1
      let matches = 0
      let looked = 0
      for (let i = 0; i < span; i += stride) {
        if (window[i] === window[i + p]) matches++
        looked++
      }
      const rate = matches / looked
      if (rate >= 0.6 && (!best || rate > best.confidence + 0.02)) {
        best = { period: p, confidence: rate }
      }
    }
    return best
  }

  private splitFrames(
    window: Uint8Array,
    shape: { delim: { byte: number; gap: number; confidence: number } | null; period: { period: number; confidence: number } | null },
  ): Uint8Array[] {
    const frames: Uint8Array[] = []
    const delim = shape.delim
    if (delim) {
      let start = 0
      for (let i = 0; i < window.length; i++) {
        if (window[i] === delim.byte) {
          if (i > start) frames.push(window.subarray(start, i))
          start = i + 1
        }
      }
      if (frames.length >= 2) return frames.slice(0, 64)
      frames.length = 0
    }
    const period = shape.period
    if (period) {
      for (let i = 0; i + period.period <= window.length; i += period.period) {
        frames.push(window.subarray(i, i + period.period))
      }
      return frames.slice(0, 64)
    }
    return frames
  }

  private detectStructure(
    shape: { delim: { byte: number; gap: number; confidence: number } | null; period: { period: number; confidence: number } | null },
    frames: Uint8Array[],
  ): StructureHint[] {
    const hints: StructureHint[] = []

    const delim = shape.delim
    if (delim) {
      hints.push({
        kind: 'delimiter',
        value: delim.byte,
        detail: `0x${delim.byte.toString(16).padStart(2, '0')} every ${delim.gap} bytes`,
        confidence: delim.confidence,
      })
    }

    const period = shape.period
    if (period) {
      hints.push({
        kind: 'fixed-frame',
        value: period.period,
        detail: `${period.period} byte frames repeat`,
        confidence: period.confidence,
      })
    }

    if (frames.length >= 3) {
      const usable = frames.filter((f) => f.length >= 4)
      for (let offset = 0; offset < 4 && usable.length >= 3; offset++) {
        for (const adjust of [0, -1, -2, 1, 2]) {
          let hit = 0
          for (const f of usable) {
            if (offset >= f.length) continue
            if (f[offset] === f.length + adjust) hit++
          }
          const ratio = hit / usable.length
          if (ratio >= 0.75) {
            const sign = adjust === 0 ? '' : adjust > 0 ? ` plus ${adjust}` : ` minus ${-adjust}`
            hints.push({
              kind: 'length-prefix',
              value: offset,
              detail: `byte ${offset} holds the frame length${sign}`,
              confidence: ratio,
            })
            offset = 4
            break
          }
        }
      }
    }

    return hints.sort((a, b) => b.confidence - a.confidence)
  }
}

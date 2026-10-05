/**
 * Block synchronisation and error correction, IEC 62106 annex B and C.
 *
 * A block is 16 data bits and a 10 bit check word with an offset word added,
 * and the offset says which of the four blocks of a group it is. Sync needs
 * three offsets in the right cyclic rhythm, and is dropped when too many of
 * the last fifty blocks fail their check.
 */

export type Offset = 'A' | 'B' | 'C' | 'Cp' | 'D'

/** Four blocks, null where one could not be received or corrected. */
export interface RdsGroup {
  blocks: [number | null, number | null, number | null, number | null]
  /** Offset of block 3, which tells a version B group by C prime. */
  cPrime: boolean
  /**
   * Span of the error burst corrected in each block, 0 for a clean block.
   * A long burst is the likelier to be a miscorrection.
   */
  bursts: [number, number, number, number]
}

const BLOCK_BITS = 26
const MASK = (1 << BLOCK_BITS) - 1

const PARITY = [
  0b1000000000, 0b0100000000, 0b0010000000, 0b0001000000, 0b0000100000, 0b0000010000,
  0b0000001000, 0b0000000100, 0b0000000010, 0b0000000001, 0b1011011100, 0b0101101110,
  0b0010110111, 0b1010000111, 0b1110011111, 0b1100010011, 0b1101010101, 0b1101110110,
  0b0110111011, 0b1000000001, 0b1111011100, 0b0111101110, 0b0011110111, 0b1010100111,
  0b1110001111, 0b1100011011,
]

const OFFSET_WORD: Record<Offset, number> = {
  A: 0b0011111100,
  B: 0b0110011000,
  C: 0b0101101000,
  Cp: 0b1101010000,
  D: 0b0110110100,
}

const BLOCK_OF: Record<Offset, number> = { A: 0, B: 1, C: 2, Cp: 2, D: 3 }
const NEXT: Record<Offset, Offset> = { A: 'B', B: 'C', C: 'D', Cp: 'D', D: 'A' }

export function syndrome(word: number): number {
  let s = 0
  for (let k = 0; k < BLOCK_BITS; k++) {
    if ((word >>> k) & 1) s ^= PARITY[BLOCK_BITS - 1 - k]
  }
  return s
}

const OFFSET_BY_SYNDROME = new Map<number, Offset>()
for (const o of Object.keys(OFFSET_WORD) as Offset[]) {
  OFFSET_BY_SYNDROME.set(syndrome(OFFSET_WORD[o]), o)
}

/**
 * For each offset, the syndrome every correctable burst leaves behind. A
 * burst of length n starts and ends on an error, so its pattern is 1, any
 * n minus 2 bits, then 1.
 */
function burstTable(maxBurst: number): Map<Offset, Map<number, number>> {
  const patterns: number[] = [1]
  for (let len = 2; len <= maxBurst; len++) {
    for (let inner = 0; inner < 1 << (len - 2); inner++) {
      patterns.push((1 << (len - 1)) | (inner << 1) | 1)
    }
  }
  const table = new Map<Offset, Map<number, number>>()
  for (const o of Object.keys(OFFSET_WORD) as Offset[]) {
    const m = new Map<number, number>()
    for (const p of patterns) {
      for (let shift = 0; shift + Math.floor(Math.log2(p)) < BLOCK_BITS; shift++) {
        const e = (p << shift) & MASK
        const s = syndrome(e ^ OFFSET_WORD[o])
        // a shorter burst is the likelier one, so it keeps the slot.
        if (!m.has(s)) m.set(s, e)
      }
    }
    table.set(o, m)
  }
  return table
}

function span(e: number): number {
  return 32 - Math.clz32(e) - (31 - Math.clz32(e & -e))
}

interface Pulse {
  offset: Offset
  at: number
}

export interface BlockSyncOptions {
  /** Longest error burst corrected in one block. The standard allows 5. */
  maxBurst?: number
}

export class BlockSync {
  private reg = 0
  private bitCount = 0
  private untilNext = 1
  private synced = false
  private expected: Offset = 'A'
  private pulses: Pulse[] = []
  private errors: number[] = []
  private current: RdsGroup = BlockSync.empty()
  private readonly table: Map<Offset, Map<number, number>>
  /** Blocks checked and failed since sync, over the last fifty. */
  private errorSum = 0

  blocksReceived = 0
  blocksFailed = 0

  onGroup: (g: RdsGroup) => void = () => {}

  constructor(opts: BlockSyncOptions = {}) {
    this.table = burstTable(Math.max(1, Math.min(10, opts.maxBurst ?? 5)))
  }

  get isSynced(): boolean {
    return this.synced
  }

  /** Share of the last fifty blocks that failed, 0 to 1. */
  get blockErrorRate(): number {
    return this.errors.length ? this.errorSum / this.errors.length : 1
  }

  reset(): void {
    this.reg = 0
    this.bitCount = 0
    this.untilNext = 1
    this.synced = false
    this.pulses = []
    this.errors = []
    this.errorSum = 0
    this.current = BlockSync.empty()
  }

  private static empty(): RdsGroup {
    return { blocks: [null, null, null, null], cPrime: false, bursts: [0, 0, 0, 0] }
  }

  push(bit: number): void {
    this.reg = ((this.reg << 1) | (bit & 1)) & MASK
    this.bitCount++
    if (--this.untilNext > 0) return
    this.examine()
    this.untilNext = this.synced ? BLOCK_BITS : 1
  }

  private examine(): void {
    const word = this.reg
    const found = OFFSET_BY_SYNDROME.get(syndrome(word)) ?? null

    if (!this.synced) {
      if (found) this.acquire(found)
      if (!this.synced) return
    }

    let expected = this.expected
    if (expected === 'C' && found === 'Cp') expected = 'Cp'

    const failed = found !== expected
    this.track(failed)
    if (this.errorSum > 42) {
      // EN 50067 C.1.2: sync is lost when the check keeps failing.
      this.synced = false
      this.pulses = []
      this.errors = []
      this.errorSum = 0
      return
    }

    let data: number | null = null
    let burst = 0
    if (!failed) {
      data = word >>> 10
    } else {
      const e = this.table.get(expected)?.get(syndrome(word))
      if (e !== undefined) {
        data = (word ^ e) >>> 10
        burst = span(e)
      }
    }
    this.blocksReceived++
    if (data === null) this.blocksFailed++

    const idx = BLOCK_OF[expected]
    this.current.blocks[idx] = data
    this.current.bursts[idx] = burst
    if (idx === 2) this.current.cPrime = expected === 'Cp'

    const next = NEXT[expected]
    if (next === 'A') {
      const g = this.current
      this.current = BlockSync.empty()
      if (g.blocks.some((b) => b !== null)) this.onGroup(g)
    }
    this.expected = next
  }

  private track(failed: boolean): void {
    this.errors.push(failed ? 1 : 0)
    this.errorSum += failed ? 1 : 0
    if (this.errors.length > 50) this.errorSum -= this.errors.shift() ?? 0
  }

  private acquire(offset: Offset): void {
    const pulse = { offset, at: this.bitCount }
    this.pulses.push(pulse)
    if (this.pulses.length > 6) this.pulses.shift()
    const follows = (b: Pulse, a: Pulse): boolean => {
      const d = b.at - a.at
      return (
        d > 0 &&
        d % BLOCK_BITS === 0 &&
        d / BLOCK_BITS <= 6 &&
        (BLOCK_OF[a.offset] + d / BLOCK_BITS) % 4 === BLOCK_OF[b.offset]
      )
    }
    const n = this.pulses.length
    for (let i = 0; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        if (follows(pulse, this.pulses[j]) && follows(this.pulses[j], this.pulses[i])) {
          this.synced = true
          this.expected = offset
          this.current = BlockSync.empty()
          this.errors = []
          this.errorSum = 0
          return
        }
      }
    }
  }
}

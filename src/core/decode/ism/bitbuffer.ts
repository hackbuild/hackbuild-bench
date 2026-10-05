/**
 * Rows of bits as the pulse slicers produce them.
 *
 * A port of rtl_433's bitbuffer.c (GPL-2.0-or-later, Tommy Vestermark). Rows
 * are fixed size and zero filled, because the protocol decoders read bytes
 * past the end of a short row and expect zeros there, as they do in C.
 */

/** Bytes per row. rtl_433 builds with 128 and lets a long row spill into the next. */
export const ROW_BYTES = 1024
export const MAX_ROWS = 50
const MAX_ROW_BITS = ROW_BYTES * 8

export class BitBuffer {
  rows: Uint8Array[] = []
  bits: number[] = []
  syncs: number[] = []

  get numRows(): number {
    return this.rows.length
  }

  clear(): void {
    for (let r = 0; r < this.rows.length; r++) {
      // decoders may write a few bytes past a short row, so the head is always cleared.
      this.rows[r].fill(0, 0, Math.min(ROW_BYTES, Math.max(32, (this.bits[r] >> 3) + 2)))
    }
    this.pool.push(...this.rows)
    this.rows = []
    this.bits = []
    this.syncs = []
  }

  private pool: Uint8Array[] = []

  private newRow(): void {
    this.rows.push(this.pool.pop() ?? new Uint8Array(ROW_BYTES))
    this.bits.push(0)
    this.syncs.push(0)
  }

  addBit(bit: number): void {
    if (!this.rows.length) this.newRow()
    const r = this.rows.length - 1
    const n = this.bits[r]
    if (n >= MAX_ROW_BITS) return
    if (bit) this.rows[r][n >> 3] |= 0x80 >> (n & 7)
    this.bits[r] = n + 1
  }

  addRow(): void {
    if (!this.rows.length) this.newRow()
    if (this.rows.length < MAX_ROWS) {
      this.newRow()
    } else {
      // out of rows: the last one is reused, which keeps the newest data.
      const r = this.rows.length - 1
      this.rows[r].fill(0)
      this.bits[r] = 0
    }
  }

  addSync(): void {
    if (!this.rows.length) this.newRow()
    if (this.bits[this.rows.length - 1]) this.addRow()
    this.syncs[this.rows.length - 1]++
  }

  invert(): void {
    for (let r = 0; r < this.rows.length; r++) {
      const n = this.bits[r]
      if (!n) continue
      const b = this.rows[r]
      const lastCol = (n - 1) >> 3
      const lastBits = ((n - 1) & 7) + 1
      for (let c = 0; c <= lastCol; c++) b[c] = ~b[c] & 0xff
      b[lastCol] ^= 0xff >> lastBits
    }
  }

  /** Copies `len` bits from `pos` into whole bytes, the last one masked. */
  extractBytes(row: number, pos: number, len: number, out?: Uint8Array): Uint8Array {
    const dst = out ?? new Uint8Array((len + 7) >> 3)
    if (len <= 0) return dst
    const src = this.rows[row]
    const bytes = (len + 7) >> 3
    if ((pos & 7) === 0) {
      const at = pos >> 3
      for (let i = 0; i < bytes; i++) dst[i] = at + i < ROW_BYTES ? src[at + i] : 0
    } else {
      const shift = 8 - (pos & 7)
      let p = pos >> 3
      let word = p < ROW_BYTES ? src[p] : 0
      for (let i = 0; i < bytes; i++) {
        p++
        word = ((word << 8) | (p < ROW_BYTES ? src[p] : 0)) & 0xffff
        dst[i] = (word >> shift) & 0xff
      }
    }
    if (len & 7) dst[(len - 1) >> 3] &= (0xff00 >> (len & 7)) & 0xff
    return dst
  }

  bitAt(row: number, bit: number): number {
    return (this.rows[row][bit >> 3] >> (7 - (bit & 7))) & 1
  }

  /** Position of the pattern at or after `start`, or the row length when absent. */
  search(row: number, start: number, pattern: ArrayLike<number>, patternBits: number): number {
    const len = this.bits[row] ?? 0
    const b = this.rows[row]
    let ipos = start
    let ppos = 0
    while (ipos < len && ppos < patternBits) {
      const a = (b[ipos >> 3] >> (7 - (ipos & 7))) & 1
      const p = (pattern[ppos >> 3] >> (7 - (ppos & 7))) & 1
      if (a === p) {
        ppos++
        ipos++
        if (ppos === patternBits) return ipos - patternBits
      } else {
        ipos -= ppos
        ipos++
        ppos = 0
      }
    }
    return len
  }

  /** IEEE 802.3 manchester, 01 is a one. Stops at the first invalid pair. */
  manchesterDecode(row: number, start: number, out: BitBuffer, max: number): number {
    let len = this.bits[row]
    let ipos = start
    if (max && len > start + max * 2) len = start + max * 2
    while (ipos < len) {
      const b1 = this.bitAt(row, ipos++)
      const b2 = this.bitAt(row, ipos++)
      if (b1 === b2) break
      out.addBit(b2)
    }
    return ipos
  }

  differentialManchesterDecode(row: number, start: number, out: BitBuffer, max: number): number {
    let len = this.bits[row]
    let ipos = start
    let bit2 = 0
    if (max && len > start + max * 2) len = start + max * 2
    while (ipos < len) {
      const bit1 = this.bitAt(row, ipos++)
      bit2 = this.bitAt(row, ipos++)
      const bit3 = this.bitAt(row, ipos)
      if (bit1 !== bit2) {
        if (bit2 !== bit3) {
          out.addBit(0)
        } else {
          bit2 = bit1
          ipos -= 1
          break
        }
      } else {
        bit2 = 1 - bit1
        ipos -= 2
        break
      }
    }
    while (ipos < len) {
      const bit1 = this.bitAt(row, ipos++)
      if (bit1 === bit2) break
      bit2 = this.bitAt(row, ipos++)
      out.addBit(bit1 === bit2 ? 1 : 0)
    }
    return ipos
  }

  compareRows(a: number, b: number, maxBits: number): boolean {
    const na = this.bits[a]
    const nb = this.bits[b]
    const ra = this.rows[a]
    const rb = this.rows[b]
    if (maxBits === 0 || na < maxBits || nb < maxBits) {
      if (na !== nb) return false
      for (let i = 0, n = (na + 7) >> 3; i < n; i++) if (ra[i] !== rb[i]) return false
      return true
    }
    for (let i = 0, n = maxBits >> 3; i < n; i++) if (ra[i] !== rb[i]) return false
    const last = (maxBits - 1) >> 3
    const mask = (0xff00 >> (maxBits & 7)) & 0xff
    return (ra[last] & mask) === (rb[last] & mask)
  }

  countRepeats(row: number, maxBits: number): number {
    let n = 0
    for (let i = 0; i < this.rows.length; i++) if (this.compareRows(row, i, maxBits)) n++
    return n
  }

  findRepeatedRow(minRepeats: number, minBits: number): number {
    for (let i = 0; i < this.rows.length; i++) {
      if (this.bits[i] >= minBits && this.countRepeats(i, 0) >= minRepeats) return i
    }
    return -1
  }

  /** Hex of a row, for packet artifacts and the raw view. */
  hex(row: number): string {
    const n = (this.bits[row] + 7) >> 3
    let s = ''
    for (let i = 0; i < n; i++) s += this.rows[row][i].toString(16).padStart(2, '0')
    return s
  }
}

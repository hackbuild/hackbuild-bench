/**
 * MSU-MR imagery out of LRPT packets.
 *
 * Each image packet holds 14 MCUs of 8 by 8 pixels, a strip 112 pixels wide
 * and 8 tall. Fourteen packets make one 1568 pixel scan of 8 rows. The
 * compression is baseline JPEG stripped to the bone: the standard luminance
 * Huffman tables, the standard luminance quantization table scaled by a
 * quality factor carried in each packet, and the DC prediction restarting at
 * zero in every packet.
 *
 * The satellite cycles its packet counter through 43 slots per scan: 14
 * packets for each of three channels and one telemetry packet. That counter
 * is what places a strip on the right scan when frames go missing.
 */

export const MSUMR_WIDTH = 1568
export const STRIP_WIDTH = 112
export const MCU_PER_PACKET = 14
export const PACKETS_PER_SCAN = 43
export const FIRST_IMAGE_APID = 64
export const LAST_IMAGE_APID = 69
export const TELEMETRY_APID = 70

/** ITU T.81 annex K.3, table K.3: luminance DC code lengths and values. */
const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

/** Table K.5: luminance AC code lengths and run/size values. */
const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
]

/** Table K.1: luminance quantization at quality 50, natural order. */
const STD_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
  92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]

/** Natural position of the k-th coefficient in zigzag order. */
export const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
  13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52,
  45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]

/**
 * A canonical Huffman table as a lookup keyed by (length, code). Codes are at
 * most 16 bits, so a flat map per length is small.
 */
export interface Huffman {
  /** For each length 1..16, the first code and the index of its first value. */
  first: Int32Array
  count: Int32Array
  index: Int32Array
  values: number[]
  /** Encoder side: code and length by value. */
  code: Map<number, [number, number]>
}

function buildHuffman(bits: number[], values: number[]): Huffman {
  const first = new Int32Array(17)
  const count = new Int32Array(17)
  const index = new Int32Array(17)
  const code = new Map<number, [number, number]>()
  let c = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    first[len] = c
    count[len] = bits[len - 1]
    index[len] = k
    for (let i = 0; i < bits[len - 1]; i++) {
      code.set(values[k], [c, len])
      c++
      k++
    }
    c <<= 1
  }
  return { first, count, index, values, code }
}

export const DC_TABLE = buildHuffman(DC_BITS, DC_VALS)
export const AC_TABLE = buildHuffman(AC_BITS, AC_VALS)

/** The scaled table, natural order, the IJG way. */
export function quantTable(qf: number): Int32Array {
  const scale = qf >= 20 && qf < 50 ? 5000 / qf : 200 - 2 * qf
  const t = new Int32Array(64)
  for (let i = 0; i < 64; i++) t[i] = Math.max(1, Math.floor((scale / 100) * STD_QUANT[i] + 0.5))
  return t
}

const COS = (() => {
  const t = new Float64Array(64)
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) {
      t[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16) / 2
    }
  }
  return t
})()

const tmpBlock = new Float64Array(64)

/** In place 8x8 inverse DCT of dequantized coefficients, natural order, into pixels. */
export function idct8x8(coef: Float64Array, out: Uint8Array, outOffset: number, stride: number): void {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 0
      for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * coef[y * 8 + u]
      tmpBlock[y * 8 + x] = s
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0
      for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * tmpBlock[v * 8 + x]
      const p = Math.round(s) + 128
      out[outOffset + y * stride + x] = p < 0 ? 0 : p > 255 ? 255 : p
    }
  }
}

class BitReader {
  private pos = 0
  private readonly data: Uint8Array
  private readonly start: number

  constructor(data: Uint8Array, start: number) {
    this.data = data
    this.start = start
  }

  get exhausted(): boolean {
    return this.start + (this.pos >> 3) >= this.data.length
  }

  bit(): number {
    const i = this.start + (this.pos >> 3)
    const b = i < this.data.length ? (this.data[i] >> (7 - (this.pos & 7))) & 1 : 0
    this.pos++
    return b
  }

  bits(n: number): number {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.bit()
    return v
  }

  /** Reads one Huffman symbol, -1 when no code of 16 bits or less matches. */
  symbol(h: Huffman): number {
    let c = 0
    for (let len = 1; len <= 16; len++) {
      c = (c << 1) | this.bit()
      const off = c - h.first[len]
      if (off >= 0 && off < h.count[len]) return h.values[h.index[len] + off]
    }
    return -1
  }
}

function extend(v: number, size: number): number {
  return size === 0 ? 0 : v < 1 << (size - 1) ? v - (1 << size) + 1 : v
}

export interface Strip {
  /** Image APID, 64 to 69. */
  apid: number
  /** First MCU of the strip within the scan, a multiple of 14. */
  mcu: number
  /** Packet counter, 14 bits. */
  seq: number
  quality: number
  /** Milliseconds of the day in the onboard clock. */
  ms: number
  /** 8 rows of 112 pixels. */
  pixels: Uint8Array
  /** MCUs that decoded before the data ran out or broke. */
  good: number
}

const coef = new Float64Array(64)
const zz = new Int32Array(64)

/**
 * Decodes one image packet, header included. Returns null when the packet is
 * not image data or its first MCU will not decode.
 */
export function decodeStrip(packet: Uint8Array): Strip | null {
  const apid = ((packet[0] & 0x07) << 8) | packet[1]
  if (apid < FIRST_IMAGE_APID || apid > LAST_IMAGE_APID) return null
  if (packet.length < 6 + 14 + 1) return null
  const p = 6
  const ms = ((packet[p + 2] << 24) | (packet[p + 3] << 16) | (packet[p + 4] << 8) | packet[p + 5]) >>> 0
  const mcu = packet[p + 8]
  const qt = packet[p + 9]
  const dcac = packet[p + 10]
  const qfm = (packet[p + 11] << 8) | packet[p + 12]
  const qf = packet[p + 13]
  if (qt !== 0 || dcac !== 0 || qfm !== 0xfff0) return null
  if (mcu % MCU_PER_PACKET !== 0 || mcu >= MCU_PER_PACKET * 14) return null

  const q = quantTable(qf)
  const pixels = new Uint8Array(8 * STRIP_WIDTH)
  const r = new BitReader(packet, p + 14)
  let dc = 0
  let good = 0
  for (let m = 0; m < MCU_PER_PACKET; m++) {
    zz.fill(0)
    const cat = r.symbol(DC_TABLE)
    if (cat < 0 || cat > 11 || r.exhausted) break
    dc += extend(r.bits(cat), cat)
    zz[0] = dc
    let k = 1
    let broken = false
    while (k < 64) {
      const rs = r.symbol(AC_TABLE)
      if (rs < 0) {
        broken = true
        break
      }
      if (rs === 0x00) break
      const run = rs >> 4
      const size = rs & 15
      k += run
      if (k > 63) {
        broken = true
        break
      }
      zz[k] = extend(r.bits(size), size)
      k++
    }
    if (broken) break
    for (let i = 0; i < 64; i++) coef[ZIGZAG[i]] = zz[i] * q[ZIGZAG[i]]
    idct8x8(coef, pixels, m * 8, STRIP_WIDTH)
    good++
  }
  if (good === 0) return null
  return {
    apid,
    mcu,
    seq: ((packet[2] & 0x3f) << 8) | packet[3],
    quality: qf,
    ms,
    pixels,
    good,
  }
}

export interface PlacedStrip extends Strip {
  /** Scan index from the first scan of its pass, 8 pixel rows each. */
  scan: number
  /** Pixel column of the strip's left edge. */
  x: number
  /** Counts up from 0 each time the placer starts a new picture. */
  pass: number
}

/**
 * A jump in the packet counter longer than this many scans, about 40
 * seconds, is a new pass rather than a fade inside one. A fade shorter than
 * this leaves black rows where it was.
 */
export const PASS_GAP_SCANS = 30
/**
 * One picture holds at most this many scans. A pass is about 390, so this
 * only splits a picture whose counter never jumped, such as two passes
 * whose counters happen to line up.
 */
export const MAX_PASS_SCANS = 600
/** A step back this short is a reorder across channels, not a new pass. */
const REORDER_PACKETS = PACKETS_PER_SCAN

/**
 * Puts strips on scans. The 43 slot cycle has an unknown phase, so the first
 * strips wait until the telemetry packet or enough channels have been seen
 * to fix it, then everything after places as it arrives.
 */
export class ScanPlacer {
  private lastSeq = -1
  private seqU = 0
  private phase = -1
  private origin = Number.NaN
  private pending: Array<{ strip: Strip; seqU: number }> = []
  private offsets = new Map<number, number>()
  private pass = 0

  reset(): void {
    this.lastSeq = -1
    this.seqU = 0
    this.pass = 0
    this.restart()
  }

  /** Forgets the phase and the origin, so the next strips start a picture of their own. */
  private restart(): void {
    this.phase = -1
    this.origin = Number.NaN
    this.pending = []
    this.offsets.clear()
  }

  /**
   * Unwraps the 14 bit counter. A jump that is neither a short step forward
   * nor a short reorder back ends the pass: whatever still waits on the
   * phase is placed into the old picture, and the next starts a new one.
   */
  private unwrap(seq: number, out: PlacedStrip[]): number {
    if (this.lastSeq < 0) {
      this.seqU = seq
    } else {
      const d = (seq - this.lastSeq) & 0x3fff
      if (d <= PASS_GAP_SCANS * PACKETS_PER_SCAN) this.seqU += d
      else if (d >= 0x4000 - REORDER_PACKETS) this.seqU += d - 0x4000
      else {
        out.push(...this.drain())
        if (!Number.isNaN(this.origin)) this.pass++
        this.restart()
        this.seqU = seq
      }
    }
    this.lastSeq = seq
    return this.seqU
  }

  /** Sees the telemetry packet, the last slot of every cycle. */
  telemetry(seq: number): PlacedStrip[] {
    const out: PlacedStrip[] = []
    const u = this.unwrap(seq, out)
    if (this.phase < 0) {
      this.phase = mod(u + 1, PACKETS_PER_SCAN)
      out.push(...this.flush())
    }
    return out
  }

  add(strip: Strip): PlacedStrip[] {
    const out: PlacedStrip[] = []
    const u = this.unwrap(strip.seq, out)
    const start = u - strip.mcu / MCU_PER_PACKET
    if (!this.offsets.has(strip.apid)) this.offsets.set(strip.apid, mod(start, PACKETS_PER_SCAN))
    if (this.phase < 0) {
      this.pending.push({ strip, seqU: u })
      if (this.offsets.size >= 3 || this.pending.length > 3 * PACKETS_PER_SCAN) {
        this.phase = this.guessPhase()
        out.push(...this.flush())
      }
      return out
    }
    const placed = this.place(strip, u)
    if (placed) out.push(placed)
    return out
  }

  /** Places whatever is still waiting, for the end of a recording. */
  drain(): PlacedStrip[] {
    if (this.phase >= 0 || !this.pending.length) return []
    this.phase = this.guessPhase()
    return this.flush()
  }

  /** The cycle start that puts every channel's first slot closest after it. */
  private guessPhase(): number {
    const offs = [...this.offsets.values()]
    let best = offs[0] ?? 0
    let bestSpan = Infinity
    for (const s of offs) {
      let span = 0
      for (const o of offs) span = Math.max(span, mod(o - s, PACKETS_PER_SCAN))
      if (span < bestSpan) {
        bestSpan = span
        best = s
      }
    }
    return best
  }

  private flush(): PlacedStrip[] {
    const out: PlacedStrip[] = []
    for (const p of this.pending) {
      const placed = this.place(p.strip, p.seqU)
      if (placed) out.push(placed)
    }
    this.pending = []
    return out
  }

  private place(strip: Strip, u: number): PlacedStrip | null {
    const start = u - strip.mcu / MCU_PER_PACKET
    const cycle = Math.floor((start - this.phase) / PACKETS_PER_SCAN)
    if (Number.isNaN(this.origin)) this.origin = cycle
    let scan = cycle - this.origin
    if (scan < 0) return null
    if (scan >= MAX_PASS_SCANS) {
      this.pass++
      this.origin = cycle
      scan = 0
    }
    return { ...strip, scan, x: strip.mcu * 8, pass: this.pass }
  }
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n
}

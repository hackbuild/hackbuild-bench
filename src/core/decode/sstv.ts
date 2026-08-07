/**
 * Slow scan television.
 *
 * Ham operators send still pictures over a voice channel by sweeping a tone
 * between 1500 Hz for black and 2300 Hz for white, one scan line at a time,
 * with a 1200 Hz pulse marking the start of each line. A vis header at the
 * front of the transmission names the mode.
 *
 * Robot 36 and Martin M1 are decoded here. Both are 320 pixels wide. Robot 36
 * sends luminance every line and one of the two colour differences on
 * alternating lines, so a colour line only completes when its partner arrives.
 * Martin M1 sends a full green, blue, and red sweep per line.
 */

import { FreqDiscriminator, SampleTrace, clamp01, clamp255 } from './signal'

export const SSTV_BLACK_HZ = 1500
export const SSTV_WHITE_HZ = 2300
const SSTV_SPAN_HZ = SSTV_WHITE_HZ - SSTV_BLACK_HZ
/** Below this many samples a pixel window is too short to trim its edges. */
const GUARD_MIN_SAMPLES = 16
/**
 * How long the discriminator takes to follow a tone change, which is its three
 * poles over the 1000 Hz corner below. Sweeps are read this far inside their
 * own bounds.
 */
const SETTLE_MS = 0.45

export type SstvModeId = 'robot36' | 'martinm1'
/** What the panel asked for. Auto waits for a vis header to say. */
export type SstvSelect = 'auto' | SstvModeId

export interface SstvModeSpec {
  id: SstvModeId
  label: string
  /** Vis code carried in the header, 7 bits. */
  vis: number
  width: number
  height: number
  lineMs: number
  syncMs: number
}

export const SSTV_MODES: Record<SstvModeId, SstvModeSpec> = {
  robot36: {
    id: 'robot36',
    label: 'robot 36',
    vis: 0x08,
    width: 320,
    height: 240,
    lineMs: 150,
    syncMs: 9,
  },
  martinm1: {
    id: 'martinm1',
    label: 'martin m1',
    vis: 0x2c,
    width: 320,
    height: 256,
    lineMs: 446.446,
    syncMs: 4.862,
  },
}

/** Robot 36 line layout in ms from the leading edge of the sync pulse. */
export const R36 = {
  sync: 9,
  porch: 3,
  yStart: 12,
  yLen: 88,
  sepStart: 100,
  sepLen: 4.5,
  chromaStart: 106,
  chromaLen: 44,
  line: 150,
}

/** Martin M1 line layout in ms from the leading edge of the sync pulse. */
export const M1 = {
  sync: 4.862,
  porch: 0.572,
  scan: 146.432,
  sep: 0.572,
  green: 5.434,
  blue: 152.438,
  red: 299.442,
  line: 446.446,
}

/** Vis header timing. 300 ms of tone, a break, 300 ms more, then the bits. */
export const VIS = {
  leaderMs: 300,
  breakMs: 10,
  bitMs: 30,
  /** From the leading edge of the start bit to the first line's sync pulse. */
  totalMs: 300,
}

const MODE_BY_VIS = new Map<number, SstvModeSpec>([
  [SSTV_MODES.robot36.vis, SSTV_MODES.robot36],
  [SSTV_MODES.martinm1.vis, SSTV_MODES.martinm1],
])

// ---------------------------------------------------------------------------
// colour. bt.601 with the studio ranges the robot modes actually use, kept
// here so an encoder and this decoder cannot drift apart.
// ---------------------------------------------------------------------------

export function rgbToYcc(r: number, g: number, b: number): [number, number, number] {
  const y = 16 + 0.003906 * (65.738 * r + 129.057 * g + 25.064 * b)
  const cr = 128 + 0.003906 * (112.439 * r - 94.154 * g - 18.285 * b)
  const cb = 128 + 0.003906 * (-37.945 * r - 74.494 * g + 112.439 * b)
  return [y, cr, cb]
}

export function yccToRgb(y: number, cr: number, cb: number): [number, number, number] {
  const l = 1.164 * (y - 16)
  return [
    clamp255(l + 1.596 * (cr - 128)),
    clamp255(l - 0.813 * (cr - 128) - 0.392 * (cb - 128)),
    clamp255(l + 2.017 * (cb - 128)),
  ]
}

// ---------------------------------------------------------------------------

export interface SstvLineEvent {
  /** Row that changed. */
  y: number
  mode: SstvModeSpec
  image: ImageData
}

function blankImage(width: number, height: number): ImageData {
  const img = new ImageData(width, height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 10
    d[i + 1] = 10
    d[i + 2] = 10
    d[i + 3] = 255
  }
  return img
}

type State = 'hunt' | 'image'

export class SstvDecoder {
  /** Fired once per completed row, with the image so far. */
  onLine: ((e: SstvLineEvent) => void) | null = null
  /** Fired when the last row of the frame lands. */
  onComplete: ((image: ImageData, mode: SstvModeSpec) => void) | null = null
  /** Fired when a mode is locked, from a vis header or from a forced pick. */
  onStart: ((mode: SstvModeSpec) => void) | null = null

  private select: SstvSelect
  private disc = new FreqDiscriminator(1900, 1000, 3)
  private trace = new SampleTrace(1 << 18)
  private sampleRate = 0
  private state: State = 'hunt'
  private scan = 0
  private mode: SstvModeSpec | null = null
  private img: ImageData | null = null
  private row = 0
  private lineAbs = 0
  private firstLine = true

  /** Flat mid chroma, used for the half of a robot pair that has not landed. */
  private neutral = new Float32Array(320).fill(0.5)
  private pairY: Float32Array | null = null
  private pairCr: Float32Array | null = null
  private pairRow = -1

  constructor(select: SstvSelect = 'auto') {
    this.select = select
  }

  get image(): ImageData | null {
    return this.img
  }

  get locked(): SstvModeSpec | null {
    return this.mode
  }

  get lines(): number {
    return this.row
  }

  setMode(select: SstvSelect): void {
    if (select === this.select) return
    this.select = select
    this.reset()
  }

  reset(): void {
    this.trace.clear()
    this.disc.reset()
    this.state = 'hunt'
    this.scan = 0
    this.mode = null
    this.img = null
    this.row = 0
    this.lineAbs = 0
    this.firstLine = true
    this.pairY = null
    this.pairCr = null
    this.pairRow = -1
  }

  feed(audio: Float32Array, sampleRate: number): void {
    if (audio.length === 0) return
    if (sampleRate !== this.sampleRate) {
      this.sampleRate = sampleRate
      this.reset()
    }
    this.trace.push(this.disc.process(audio, sampleRate))
    this.pump()
  }

  // -------------------------------------------------------------------------

  private ms(v: number): number {
    return (v * this.sampleRate) / 1000
  }

  private pump(): void {
    for (;;) {
      const moved = this.state === 'hunt' ? this.tryHunt() : this.tryLine()
      if (!moved) break
    }
    const keep = this.state === 'hunt' ? this.scan - this.ms(400) : this.lineAbs - this.ms(60)
    this.trace.drop(keep)
  }

  /**
   * Looks for the vis header, and in a forced mode also for a bare sync pulse
   * so a transmission already in progress can still be picked up.
   */
  private tryHunt(): boolean {
    const step = Math.max(1, Math.round(this.ms(1)))
    const need = this.ms(VIS.bitMs * 10)
    const back = this.ms(VIS.leaderMs)
    if (this.scan < this.trace.base + back) this.scan = this.trace.base + back

    while (this.scan + need < this.trace.end) {
      const t = this.scan
      if (this.tryVis(t)) return true
      if (this.select !== 'auto' && this.trySyncStart(t)) return true
      this.scan += step
    }
    return false
  }

  private tryVis(t: number): boolean {
    const startBit = this.trace.mean(t, t + this.ms(10))
    if (Math.abs(startBit - 1200) > 90) return false
    const leader = this.trace.mean(t - this.ms(110), t - this.ms(20))
    if (Math.abs(leader - 1900) > 110) return false

    const edge = this.refineEdge(t)
    let code = 0
    let ones = 0
    for (let i = 0; i < 8; i++) {
      const a = edge + this.ms(VIS.bitMs * (i + 1) + 6)
      const b = edge + this.ms(VIS.bitMs * (i + 2) - 6)
      const f = this.trace.mean(a, b)
      if (Math.abs(f - 1200) > 220) return false
      const bit = f < 1200 ? 1 : 0
      if (bit) ones++
      if (i < 7) code |= bit << i
    }
    // even parity over the seven data bits, the eighth bit carrying it.
    if (ones % 2 !== 0) return false

    const mode = MODE_BY_VIS.get(code)
    if (!mode) return false
    if (this.select !== 'auto' && mode.id !== this.select) return false

    this.begin(mode, edge + this.ms(VIS.totalMs))
    return true
  }

  private trySyncStart(t: number): boolean {
    const mode = SSTV_MODES[this.select as SstvModeId]
    const sync = this.trace.mean(t, t + this.ms(mode.syncMs))
    if (Math.abs(sync - 1200) > 120) return false
    const before = this.trace.mean(t - this.ms(100), t - this.ms(10))
    // a vis leader sits at 1900. rejecting it stops a header being mistaken
    // for a line sync, which would shred the first second of the picture.
    if (Math.abs(before - 1900) < 110) return false
    this.begin(mode, this.refineEdge(t))
    return true
  }

  /** Walks back to the sample where the tone actually fell to the sync pulse. */
  private refineEdge(t: number): number {
    let edge = t
    const limit = Math.max(this.trace.base, t - this.ms(3))
    while (edge > limit && this.trace.at(edge - 1) < 1500) edge--
    return edge
  }

  private begin(mode: SstvModeSpec, lineAbs: number): void {
    this.mode = mode
    this.img = blankImage(mode.width, mode.height)
    this.neutral = new Float32Array(mode.width).fill(0.5)
    this.row = 0
    this.pairY = null
    this.pairCr = null
    this.pairRow = -1
    this.lineAbs = lineAbs
    this.firstLine = true
    this.state = 'image'
    this.onStart?.(mode)
  }

  private tryLine(): boolean {
    const mode = this.mode
    const img = this.img
    if (!mode || !img) return false

    const window = Math.round(this.ms(this.firstLine ? 30 : 4))
    const lineLen = this.ms(mode.lineMs)
    const needTo = this.lineAbs + window + lineLen + this.ms(2)
    if (this.trace.end < needTo) return false
    if (this.lineAbs - window < this.trace.base) {
      this.lineAbs = this.trace.base + window
    }

    const start = this.findSync(this.lineAbs, window, this.ms(mode.syncMs))
    this.firstLine = false

    if (mode.id === 'martinm1') this.decodeMartin(start, mode, img)
    else this.decodeRobot(start, mode, img)

    this.lineAbs = start + lineLen
    this.row++

    if (this.row >= mode.height) {
      this.state = 'hunt'
      this.scan = this.lineAbs
      this.onComplete?.(img, mode)
      return false
    }
    return true
  }

  /**
   * Slides the sync template over the search window and takes the best fit.
   *
   * Equal fits go to the one nearest where the line was expected. The vis stop
   * bit is 30 ms of the same 1200 Hz as a sync pulse, so without that rule the
   * first line locks to the head of the stop bit and every line after it is
   * decoded a fifth of a line early.
   *
   * A weak fit returns the nominal position, so a fade drops picture quality
   * rather than knocking the whole frame out of alignment.
   */
  private findSync(nominal: number, window: number, syncLen: number): number {
    const len = Math.max(2, Math.round(syncLen))
    const centre = Math.round(nominal)
    const from = centre - window
    const to = centre + window
    let count = 0
    for (let i = from; i < from + len; i++) count += this.trace.at(i) < 1400 ? 1 : 0
    let best = from
    let bestCount = count
    let bestDist = Math.abs(from - centre)
    for (let o = from + 1; o <= to; o++) {
      count += (this.trace.at(o + len - 1) < 1400 ? 1 : 0) - (this.trace.at(o - 1) < 1400 ? 1 : 0)
      const dist = Math.abs(o - centre)
      if (count > bestCount || (count === bestCount && dist < bestDist)) {
        bestCount = count
        bestDist = dist
        best = o
      }
    }
    return bestCount / len > 0.5 ? best : centre
  }

  /**
   * Averages the tone across the middle of each pixel window and maps it to
   * 0..1. The guard at each edge keeps the discriminator's ramp between two
   * neighbouring pixels out of the average. A short window, which is what a
   * robot 36 chroma pixel is, gets no guard: throwing samples away there adds
   * more noise than the smear it removes.
   *
   * The sweep is also read strictly inside its own bounds by the time the
   * discriminator takes to follow a tone change. A robot 36 chroma sweep ends
   * exactly on the line boundary, so without that the right hand column reads
   * the next line's sync pulse and comes out as a green stripe.
   */
  private sweep(
    start: number,
    offsetMs: number,
    lengthMs: number,
    width: number,
    out: Float32Array,
  ): void {
    const s = start + this.ms(offsetMs)
    const span = this.ms(lengthMs)
    const per = span / width
    const guard = per > GUARD_MIN_SAMPLES ? per * 0.2 : 0
    const settle = this.ms(SETTLE_MS)
    const first = s + settle
    const last = s + span - settle

    for (let x = 0; x < width; x++) {
      const a = s + x * per
      let lo = Math.max(a + guard, first)
      let hi = Math.min(a + per - guard, last)
      if (hi - lo < 2) {
        // a pixel that falls inside the settling window reads the nearest
        // part of the sweep that is clean, so the column repeats rather than
        // reporting whatever tone sits next to the sweep.
        if (x * 2 >= width) {
          hi = last
          lo = last - Math.max(2, per)
        } else {
          lo = first
          hi = first + Math.max(2, per)
        }
      }
      const f = this.trace.mean(lo, hi)
      out[x] = clamp01((f - SSTV_BLACK_HZ) / SSTV_SPAN_HZ)
    }
  }

  private decodeMartin(start: number, mode: SstvModeSpec, img: ImageData): void {
    const w = mode.width
    const g = new Float32Array(w)
    const b = new Float32Array(w)
    const r = new Float32Array(w)
    this.sweep(start, M1.green, M1.scan, w, g)
    this.sweep(start, M1.blue, M1.scan, w, b)
    this.sweep(start, M1.red, M1.scan, w, r)

    const o = this.row * w * 4
    for (let x = 0; x < w; x++) {
      const p = o + x * 4
      img.data[p] = r[x] * 255
      img.data[p + 1] = g[x] * 255
      img.data[p + 2] = b[x] * 255
      img.data[p + 3] = 255
    }
    this.onLine?.({ y: this.row, mode, image: img })
  }

  private decodeRobot(start: number, mode: SstvModeSpec, img: ImageData): void {
    const w = mode.width
    const y = new Float32Array(w)
    const c = new Float32Array(w)
    this.sweep(start, R36.yStart, R36.yLen, w, y)
    this.sweep(start, R36.chromaStart, R36.chromaLen, w, c)

    const sep = this.trace.mean(
      start + this.ms(R36.sepStart + 0.8),
      start + this.ms(R36.sepStart + R36.sepLen - 0.8),
    )
    // 1500 Hz on the separator means this line carries r-y, 2300 Hz means b-y.
    const isBlue = sep > 1900

    if (!isBlue) {
      this.pairY = y
      this.pairCr = c
      this.pairRow = this.row
      this.paint(img, this.row, y, c, this.neutral)
      this.onLine?.({ y: this.row, mode, image: img })
      return
    }

    if (this.pairY && this.pairCr && this.pairRow === this.row - 1) {
      this.paint(img, this.pairRow, this.pairY, this.pairCr, c)
      this.onLine?.({ y: this.pairRow, mode, image: img })
    }
    this.paint(img, this.row, y, this.pairCr ?? this.neutral, c)
    this.onLine?.({ y: this.row, mode, image: img })
  }

  private paint(
    img: ImageData,
    row: number,
    y: Float32Array,
    cr: Float32Array,
    cb: Float32Array,
  ): void {
    const w = img.width
    if (row < 0 || row >= img.height) return
    const o = row * w * 4
    for (let x = 0; x < w; x++) {
      const [r, g, b] = yccToRgb(y[x] * 255, cr[x] * 255, cb[x] * 255)
      const p = o + x * 4
      img.data[p] = r
      img.data[p + 1] = g
      img.data[p + 2] = b
      img.data[p + 3] = 255
    }
  }
}

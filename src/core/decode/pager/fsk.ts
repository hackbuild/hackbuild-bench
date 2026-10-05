/**
 * Symbol recovery for paging FSK, from a frequency discriminator's output.
 *
 * Timing is a phase accumulator pulled toward the zero crossings, which in
 * NRZ fall on symbol edges. The symbol value is the average over the middle
 * of the symbol, which is the matched filter for a rectangular pulse. The
 * levels come from the highest and lowest of the recent symbol averages:
 * their midpoint is the carrier offset and half their span the deviation.
 *
 * The window is short while hunting, so the levels are right within a
 * preamble even after a noise burst threw them wide, and long once a
 * decoder is locked, so a long run of one bit inside a page does not drag
 * the centre toward it.
 */

/** How far each zero crossing pulls the clock toward it. */
const TIMING_GAIN = 0.05
/** Share of the symbol, from each edge, left out of the average. */
const EDGE = 0.2
/** Symbols the outer levels are taken over, hunting and locked. */
const HUNT_WINDOW = 16
const LOCKED_WINDOW = 96
/** Per symbol, how far the levels move toward the window's extremes. */
const FOLLOW = 0.3
/** Four level FSK puts its inner levels at a third of the outer ones. */
const INNER = 2 / 3

export class SymbolSlicer {
  private readonly fs: number
  /** Symbols per second. FLEX changes this inside a frame. */
  rate: number
  levels: 2 | 4 = 2
  /** Freezes the levels, so a frame's inner symbols do not pull them in. */
  hold = false
  /** Widens the level window, for a decoder that has sync. */
  locked = false

  private phase = 0
  private acc = 0
  private n = 0
  private last = 0
  private hi = 0
  private lo = 0
  private primed = false
  private recent = new Float32Array(LOCKED_WINDOW)
  private recentAt = 0
  private box: Float32Array
  private boxSum = 0
  private boxAt = 0

  /**
   * `smoothFor` is the fastest rate this slicer will run at. The input is
   * averaged over half a symbol of it, which takes out discriminator noise
   * without smearing the edges the clock locks to.
   */
  constructor(sampleRate: number, rate: number, smoothFor = rate) {
    this.fs = sampleRate
    this.rate = rate
    const len = Math.max(1, Math.round(sampleRate / (2 * smoothFor)))
    this.box = new Float32Array(len)
  }

  /** The centre of the outer levels, in the input's units. */
  get center(): number {
    return (this.hi + this.lo) / 2
  }

  /** Half the span between the outer levels. */
  get span(): number {
    return (this.hi - this.lo) / 2
  }

  reset(): void {
    this.phase = this.acc = this.n = this.last = 0
    this.hi = this.lo = 0
    this.primed = false
    this.recent.fill(0)
    this.box.fill(0)
    this.boxSum = 0
  }

  /**
   * Feeds a block. `onSymbol` gets each symbol, 0 the lowest frequency to 3
   * the highest, with the average it was decided from.
   */
  process(x: Float32Array, onSymbol: (sym: number, value: number) => void): void {
    const box = this.box
    const blen = box.length
    for (let i = 0; i < x.length; i++) {
      this.boxSum += x[i] - box[this.boxAt]
      box[this.boxAt] = x[i]
      if (++this.boxAt === blen) this.boxAt = 0
      const v = this.boxSum / blen - this.center

      const ph = this.phase
      if (ph > EDGE && ph < 1 - EDGE) {
        this.acc += v
        this.n++
      }
      if ((this.last < 0) !== (v < 0)) {
        const err = ph < 0.5 ? ph : ph - 1
        this.phase -= err * TIMING_GAIN
      }
      this.last = v

      this.phase += this.rate / this.fs
      if (this.phase < 1) continue
      this.phase -= 1
      const mean = this.n ? this.acc / this.n : v
      this.acc = 0
      this.n = 0
      onSymbol(this.decide(mean), mean)
    }
  }

  private decide(mean: number): number {
    const raw = mean + this.center
    const recent = this.recent
    recent[this.recentAt] = raw
    this.recentAt = (this.recentAt + 1) % LOCKED_WINDOW
    if (!this.primed) {
      recent.fill(raw)
      this.primed = true
    }
    if (!this.hold) {
      const w = this.locked ? LOCKED_WINDOW : HUNT_WINDOW
      let top = -Infinity
      let bottom = Infinity
      for (let k = 1; k <= w; k++) {
        const v = recent[(this.recentAt - k + LOCKED_WINDOW) % LOCKED_WINDOW]
        if (v > top) top = v
        if (v < bottom) bottom = v
      }
      this.hi += (top - this.hi) * FOLLOW
      this.lo += (bottom - this.lo) * FOLLOW
    }
    if (this.levels === 2) return mean > 0 ? 3 : 0
    const t = this.span * INNER
    if (mean > 0) return mean > t ? 3 : 2
    return mean < -t ? 0 : 1
  }
}

/**
 * SAME audio to characters: 2083.3 Hz mark and 1562.5 Hz space at 520.83
 * baud, eight bit ASCII sent least significant bit first, each burst opening
 * with sixteen 0xAB preamble bytes. 47 CFR 11.31.
 */

export const SAME_MARK_HZ = 6250 / 3
export const SAME_SPACE_HZ = 1562.5
export const SAME_BAUD = 6250 / 12

const PREAMBLE = 0xab
/** A header is at most this long, 47 CFR 11.31 with 31 locations. */
const MAX_BURST = 268

export class SameAfsk {
  readonly rate: number
  private readonly n: number
  private readonly markStep: [number, number]
  private readonly spaceStep: [number, number]
  private mc = 1
  private ms = 0
  private sc = 1
  private ss = 0
  private since = 0
  // sliding one bit sums of each tone, mixed to zero
  private readonly ring: Float32Array
  private pos = 0
  private mI = 0
  private mQ = 0
  private sI = 0
  private sQ = 0
  private phase = 0
  private readonly step: number
  private lastSign = 0
  private reg = 0
  private inBurst = false
  private bitInByte = 0
  private byte = 0
  private chars: number[] = []
  private dashesAfterPlus = -1
  /** Samples seen, for timing bursts against each other. */
  samples = 0

  /** A burst's text, without its preamble, and the sample it ended on. */
  onBurst: (text: string, atSample: number) => void = () => {}

  constructor(rate: number) {
    this.rate = rate
    this.n = Math.max(4, Math.round(rate / SAME_BAUD))
    const wm = (2 * Math.PI * SAME_MARK_HZ) / rate
    const ws = (2 * Math.PI * SAME_SPACE_HZ) / rate
    this.markStep = [Math.cos(wm), Math.sin(wm)]
    this.spaceStep = [Math.cos(ws), Math.sin(ws)]
    this.ring = new Float32Array(this.n * 4)
    this.step = SAME_BAUD / rate
  }

  process(audio: Float32Array): void {
    const n = this.n
    const ring = this.ring
    const [mcs, mss] = this.markStep
    const [scs, sss] = this.spaceStep
    for (let k = 0; k < audio.length; k++) {
      const x = audio[k]
      const mi = x * this.mc
      const mq = x * this.ms
      const si = x * this.sc
      const sq = x * this.ss
      let nc = this.mc * mcs - this.ms * mss
      this.ms = this.mc * mss + this.ms * mcs
      this.mc = nc
      nc = this.sc * scs - this.ss * sss
      this.ss = this.sc * sss + this.ss * scs
      this.sc = nc
      if (++this.since >= 4096) {
        this.since = 0
        let m = Math.hypot(this.mc, this.ms) || 1
        this.mc /= m
        this.ms /= m
        m = Math.hypot(this.sc, this.ss) || 1
        this.sc /= m
        this.ss /= m
      }
      const p = this.pos * 4
      this.mI += mi - ring[p]
      this.mQ += mq - ring[p + 1]
      this.sI += si - ring[p + 2]
      this.sQ += sq - ring[p + 3]
      ring[p] = mi
      ring[p + 1] = mq
      ring[p + 2] = si
      ring[p + 3] = sq
      this.pos = this.pos + 1 === n ? 0 : this.pos + 1
      this.samples++

      const em = this.mI * this.mI + this.mQ * this.mQ
      const es = this.sI * this.sI + this.sQ * this.sQ
      const d = em - es
      const sign = d > 0 ? 1 : -1

      // the one bit window straddles a bit boundary evenly when the tones
      // cross, which is half a bit before the next sampling instant.
      if (sign !== this.lastSign && this.lastSign !== 0) {
        this.phase += (0.5 - this.phase) * 0.25
      }
      this.lastSign = sign

      this.phase += this.step
      if (this.phase >= 1) {
        this.phase -= 1
        this.bit(d > 0 ? 1 : 0)
      }
    }
  }

  private bit(b: number): void {
    this.reg = ((this.reg >>> 1) | (b << 7)) & 0xff
    if (!this.inBurst) {
      if (this.reg === PREAMBLE) {
        this.inBurst = true
        this.bitInByte = 0
        this.byte = 0
        this.chars = []
        this.dashesAfterPlus = -1
      }
      return
    }
    this.byte |= b << this.bitInByte
    if (++this.bitInByte < 8) return
    const c = this.byte
    this.byte = 0
    this.bitInByte = 0
    if (this.chars.length === 0 && c === PREAMBLE) return
    this.take(c)
  }

  private take(c: number): void {
    const printable = c >= 0x20 && c < 0x7f
    if (!printable) {
      this.end()
      return
    }
    this.chars.push(c)
    const len = this.chars.length
    if (len === 4) {
      const head = String.fromCharCode(...this.chars)
      if (head === 'NNNN') {
        this.end()
        return
      }
      if (head !== 'ZCZC') {
        this.inBurst = false
        return
      }
    }
    if (c === 0x2b) this.dashesAfterPlus = 0
    else if (c === 0x2d && this.dashesAfterPlus >= 0) {
      // purge time, issue time and station id each close with a dash.
      if (++this.dashesAfterPlus === 3) {
        this.end()
        return
      }
    }
    if (len >= MAX_BURST) this.end()
  }

  private end(): void {
    this.inBurst = false
    if (this.chars.length < 4) return
    let text = String.fromCharCode(...this.chars)
    if (text.startsWith('ZCZC')) {
      const last = text.lastIndexOf('-')
      text = last > 0 ? text.slice(0, last + 1) : text
    }
    this.onBurst(text, this.samples)
  }
}

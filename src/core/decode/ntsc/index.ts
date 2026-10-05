/**
 * Analog NTSC television, black and white, from an rtl-sdr's window.
 *
 * Analog tv puts its picture on a carrier with negative amplitude
 * modulation: sync tips are full power, blanking three quarters, and white
 * an eighth. The picture's detail rides up to 4.2 MHz above the carrier and
 * a vestige 0.75 MHz below. An rtl-sdr's window takes the carrier and the
 * first megahertz and a half of detail, so the picture comes out soft, about
 * a third of broadcast sharpness, but whole: every line and field is there.
 * Colour rides 3.58 MHz up and is out of reach, as is the sound at 4.5 MHz.
 *
 * The chain: the carrier is found in the window and mixed to dc, a slow
 * average of it gives the phase to detect against, and the in-phase part is
 * the picture's amplitude. A line clock locks to the rising edges of the
 * sync tips, the broad pulses of vertical sync place each field, and the
 * two fields are woven into a 320 by 480 frame.
 */

import { Fft } from '@/core/dsp/fft'

/** NTSC line rate, 4.5 MHz over 286. */
export const LINE_HZ = 4_500_000 / 286
export const FRAME_W = 320
export const FRAME_H = 480

const SYNC_S = 4.7e-6
const ACTIVE_START_S = 10.9e-6
/** From the end of the back porch to the start of the front porch. */
const ACTIVE_S = 51.16e-6
/** How far either side of the expected line start a locked clock looks. */
const LOCKED_SEARCH = 0.04
const ACQUIRE_N = 32_768
/** How far from the expected carrier the search reaches, unless told otherwise. */
const CARRIER_SEARCH_HZ = 80_000
/** A carrier under this, over the noise beside it, is not decoded. */
const MIN_CARRIER_DB = 12
/** Lines between one field's vertical sync and the next. */
const FIELD_LINES = 262.5

export interface NtscStatus {
  /** The carrier was found this far over the noise around it, in dB. */
  carrierDb: number
  /** Where the carrier sits from the window centre, in Hz. */
  carrierOffsetHz: number
  /** The line clock follows the sync pulses. */
  lineLock: boolean
  /** Vertical sync is placing the fields. */
  fieldLock: boolean
  /** Share of the last lines whose sync pulse was where it belonged. */
  syncQuality: number
  /** Sync tip over blanking, against the noise on the back porch, in dB. */
  snrDb: number
  frames: number
}

export interface PictureLevels {
  /** Added to the picture, -1 to 1. */
  brightness: number
  /** Multiplies the picture, 0.25 to 4. */
  contrast: number
}

export class NtscDecoder {
  onFrame: ((pixels: Uint8ClampedArray) => void) | null = null

  private readonly rate: number
  private readonly lineLen: number
  private readonly syncLen: number
  private expectedOffset: number
  private readonly searchHz: number

  // carrier
  private acquired = false
  private acqI = new Float32Array(ACQUIRE_N)
  private acqQ = new Float32Array(ACQUIRE_N)
  private acqFill = 0
  /** Samples to let pass before looking for the carrier again. */
  private acqWait = 0
  /** Lines in a row without line lock, which after a while means the carrier went. */
  private unlockedLines = 0
  private ncoPhase = 0
  private ncoStep = 0
  private refI = 0
  private refQ = 0
  private readonly refAlpha: number
  private lastRefI = 0
  private lastRefQ = 0
  private fllCount = 0
  private dcI = 0
  private dcQ = 0
  carrierDb = 0

  // the detected amplitude, waiting to be cut into lines
  private buf = new Float32Array(1 << 18)
  private len = 0

  // line clock
  private next = 0
  private period: number
  private lineLock = false
  private goodRun = 0
  private missed = 0
  private tipT = 1
  private blankT = 0.75
  private noiseT = 0.01
  private recent: number[] = []

  // fields
  private lineNo = 0
  private fieldLock = false
  private prevBroad1 = false
  private prevBroad2 = false
  private sinceVsync = 0
  private vRun = 0
  private readonly frame = new Uint8ClampedArray(FRAME_W * FRAME_H)
  frames = 0

  levels: PictureLevels = { brightness: 0, contrast: 1 }

  constructor(rate: number, carrierOffsetHz: number, searchHz = CARRIER_SEARCH_HZ) {
    this.rate = rate
    this.searchHz = searchHz
    this.lineLen = rate / LINE_HZ
    this.period = this.lineLen
    this.syncLen = Math.max(2, Math.round(SYNC_S * rate))
    this.expectedOffset = carrierOffsetHz
    // the reference follows the carrier's phase over about a quarter of a line.
    this.refAlpha = 1 - Math.exp((-2 * Math.PI * 3000) / rate)
  }

  get status(): NtscStatus {
    const good = this.recent.length ? this.recent.reduce((a, b) => a + b, 0) / this.recent.length : 0
    const swing = this.tipT - this.blankT
    return {
      carrierDb: this.carrierDb,
      carrierOffsetHz: (-this.ncoStep * this.rate) / (2 * Math.PI),
      lineLock: this.lineLock,
      fieldLock: this.fieldLock,
      syncQuality: good,
      snrDb: swing > 0 ? 20 * Math.log10(swing / Math.max(1e-9, this.noiseT)) : 0,
      frames: this.frames,
    }
  }

  feed(iq: Float32Array): void {
    for (let n = 0; n + 1 < iq.length; n += 2) {
      // a zero if tuner leaves a dc spike at the centre, which would bias the reference.
      this.dcI += (iq[n] - this.dcI) * 1e-4
      this.dcQ += (iq[n + 1] - this.dcQ) * 1e-4
      const x = iq[n] - this.dcI
      const y = iq[n + 1] - this.dcQ
      if (!this.acquired) {
        if (this.acqWait > 0) {
          this.acqWait--
          continue
        }
        this.acqI[this.acqFill] = x
        this.acqQ[this.acqFill] = y
        if (++this.acqFill === ACQUIRE_N) this.acquire()
        continue
      }
      this.sample(x, y)
    }
    this.cutLines()
  }

  /** Finds the strongest carrier near where it was expected. */
  private acquire(): void {
    const fft = new Fft(ACQUIRE_N)
    const re = new Float32Array(ACQUIRE_N)
    const im = new Float32Array(ACQUIRE_N)
    for (let i = 0; i < ACQUIRE_N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / ACQUIRE_N)
      re[i] = this.acqI[i] * w
      im[i] = this.acqQ[i] * w
    }
    fft.transform(re, im)
    const binHz = this.rate / ACQUIRE_N
    let best = 0
    let bestHz = this.expectedOffset
    const around: number[] = []
    for (let hz = this.expectedOffset - this.searchHz; hz <= this.expectedOffset + this.searchHz; hz += binHz) {
      const k = ((Math.round(hz / binHz) % ACQUIRE_N) + ACQUIRE_N) % ACQUIRE_N
      const p = re[k] * re[k] + im[k] * im[k]
      around.push(p)
      if (p > best) {
        best = p
        bestHz = hz
      }
    }
    around.sort((a, b) => a - b)
    this.carrierDb = 10 * Math.log10(best / (around[around.length >> 1] || 1e-30))
    this.ncoStep = (-2 * Math.PI * bestHz) / this.rate
    this.acqFill = 0
    // with no carrier there is nothing to lock to, and noise would lock to anything.
    if (this.carrierDb < MIN_CARRIER_DB) {
      this.acqWait = Math.round(this.rate / 2)
      this.lineLock = false
      this.fieldLock = false
      return
    }
    this.acquired = true
    this.unlockedLines = 0
  }

  private sample(x: number, y: number): void {
    const c = Math.cos(this.ncoPhase)
    const s = Math.sin(this.ncoPhase)
    this.ncoPhase += this.ncoStep
    if (this.ncoPhase > Math.PI) this.ncoPhase -= 2 * Math.PI
    else if (this.ncoPhase < -Math.PI) this.ncoPhase += 2 * Math.PI
    const i = x * c - y * s
    const q = x * s + y * c
    this.refI += (i - this.refI) * this.refAlpha
    this.refQ += (q - this.refQ) * this.refAlpha
    // the reference turning means the mixer is off frequency, so it is nudged.
    if (++this.fllCount === 2048) {
      this.fllCount = 0
      const dot = this.refI * this.lastRefI + this.refQ * this.lastRefQ
      const cross = this.refQ * this.lastRefI - this.refI * this.lastRefQ
      const turn = Math.atan2(cross, dot) / 2048
      this.ncoStep -= turn * 0.25
      this.lastRefI = this.refI
      this.lastRefQ = this.refQ
    }
    const mag = Math.hypot(this.refI, this.refQ) || 1e-12
    // only the reference's phase is used. its size follows the picture, so
    // dividing by it would act as a fast agc and bend every line's levels.
    const v = (i * this.refI + q * this.refQ) / mag
    if (this.len === this.buf.length) {
      const grown = new Float32Array(this.buf.length * 2)
      grown.set(this.buf)
      this.buf = grown
    }
    this.buf[this.len++] = v
  }

  private mean(a: number, b: number): number {
    const lo = Math.max(0, Math.floor(a))
    const hi = Math.min(this.len, Math.floor(b))
    let s = 0
    for (let k = lo; k < hi; k++) s += this.buf[k]
    return hi > lo ? s / (hi - lo) : 0
  }

  private std(a: number, b: number, m: number): number {
    const lo = Math.max(0, Math.floor(a))
    const hi = Math.min(this.len, Math.floor(b))
    let s = 0
    for (let k = lo; k < hi; k++) s += (this.buf[k] - m) ** 2
    return hi > lo ? Math.sqrt(s / (hi - lo)) : 0
  }

  private fracAbove(a: number, b: number, thr: number): number {
    const lo = Math.max(0, Math.floor(a))
    const hi = Math.min(this.len, Math.floor(b))
    let k = 0
    for (let j = lo; j < hi; j++) if (this.buf[j] > thr) k++
    return hi > lo ? k / (hi - lo) : 0
  }

  /** The first rise through the threshold in a span, to a fraction of a sample. */
  private rise(a: number, b: number, thr: number): number | null {
    const lo = Math.max(2, Math.floor(a))
    const hi = Math.min(this.len - 2, Math.ceil(b))
    const sm = (k: number) => (this.buf[k - 1] + this.buf[k] + this.buf[k + 1]) / 3
    let prev = sm(lo - 1)
    for (let k = lo; k <= hi; k++) {
      const cur = sm(k)
      if (prev < thr && cur >= thr) return k - 1 + (thr - prev) / (cur - prev || 1e-12)
      prev = cur
    }
    return null
  }

  /** The start of the strongest sync shaped pulse in a span. */
  private strongest(a: number, b: number): number {
    const lo = Math.max(0, Math.floor(a))
    const hi = Math.min(this.len - this.syncLen, Math.floor(b))
    let s = 0
    for (let k = lo; k < lo + this.syncLen; k++) s += this.buf[k]
    let best = s
    let at = lo
    for (let k = lo + 1; k <= hi; k++) {
      s += this.buf[k + this.syncLen - 1] - this.buf[k - 1]
      if (s > best) {
        best = s
        at = k
      }
    }
    return at
  }

  private cutLines(): void {
    const L = this.lineLen
    const us = this.rate / 1e6
    while (this.next + 2 * L + 4 < this.len) {
      let edge: number
      if (!this.lineLock && ++this.unlockedLines > 2 * LINE_HZ) {
        // two seconds with no lock: the carrier is looked for afresh.
        this.acquired = false
        this.len = 0
        this.next = 0
        this.goodRun = 0
        return
      }
      if (!this.lineLock) {
        const k = this.strongest(this.next, this.next + L)
        const tip = this.mean(k, k + this.syncLen)
        const blank = this.mean(k + this.syncLen + 0.6 * us, k + this.syncLen + 4 * us)
        const thr = (tip + blank) / 2
        const r = this.rise(k - 3, k + 3, thr) ?? k
        const ok = tip - blank > 0.08 * Math.abs(tip)
        if (ok) {
          this.tipT = tip
          this.blankT = blank
          this.goodRun++
          if (this.goodRun >= 8) {
            this.lineLock = true
            this.missed = 0
            this.unlockedLines = 0
          }
        } else {
          this.goodRun = 0
        }
        edge = r
        this.next = edge + L
        this.compact(edge)
        continue
      }

      const thr = (this.tipT + this.blankT) / 2
      const w = LOCKED_SEARCH * L
      // a sync no taller than the noise is not a sync.
      const tall = this.tipT - this.blankT > 3 * this.noiseT
      const found = tall ? this.rise(this.next - w, this.next + w, thr) : null
      let err = 0
      if (found !== null) {
        edge = found
        err = found - this.next
        this.missed = 0
      } else {
        edge = this.next
        this.missed++
      }
      this.recent.push(found !== null ? 1 : 0)
      if (this.recent.length > 200) this.recent.shift()

      const broad1 = this.fracAbove(edge + 0.1 * L, edge + 0.42 * L, thr) > 0.7
      const broad2 = this.fracAbove(edge + 0.6 * L, edge + 0.92 * L, thr) > 0.7
      const normal = !broad1 && !broad2 && this.mean(edge + 5.6 * us, edge + 8.6 * us) < thr
      if (normal && found !== null) {
        const tip = this.mean(edge + 0.8 * us, edge + 4 * us)
        const porchFrom = edge + 5.6 * us
        const porchTo = edge + 8.6 * us
        const blank = this.mean(porchFrom, porchTo)
        this.tipT += (tip - this.tipT) * 0.05
        this.blankT += (blank - this.blankT) * 0.05
        this.noiseT += (this.std(porchFrom, porchTo, blank) - this.noiseT) * 0.05
      }

      this.vertical(broad1, broad2)
      if (normal) this.draw(edge)
      this.lineNo++
      this.sinceVsync++
      if (this.sinceVsync > 700) this.fieldLock = false

      // a second order loop: the phase follows quickly, the period slowly.
      this.period += err * 0.01
      const nominal = this.lineLen
      this.period = Math.max(nominal * 0.99, Math.min(nominal * 1.01, this.period))
      this.next = this.next + this.period + err * 0.35
      if (this.missed > 30) {
        this.lineLock = false
        this.goodRun = 0
        this.period = nominal
      }
      this.compact(edge)
    }
  }

  /** Drops what is behind the line just cut, keeping a little for the next search. */
  private compact(edge: number): void {
    const keep = Math.floor(edge - this.lineLen * 0.25)
    if (keep < this.lineLen * 64) return
    this.buf.copyWithin(0, keep, this.len)
    this.len -= keep
    this.next -= keep
  }

  /**
   * Vertical sync is three lines of broad pulses. A field whose broad pulses
   * start at a line start is the first; one whose start mid line is the
   * second.
   */
  private vertical(broad1: boolean, broad2: boolean): void {
    const started = !this.prevBroad1 && !this.prevBroad2
    // a vertical sync counts toward lock only a field after the last one.
    const spaced = Math.abs(this.sinceVsync - FIELD_LINES) <= 3
    if (broad1 && started) {
      this.vRun = spaced ? this.vRun + 1 : 0
      this.fieldLock = this.vRun >= 2
      this.lineNo = 4
      this.sinceVsync = 0
      if (this.fieldLock) this.emit()
    } else if (broad2 && !broad1 && started) {
      this.vRun = spaced ? this.vRun + 1 : 0
      this.fieldLock = this.vRun >= 2
      this.lineNo = 266
      this.sinceVsync = 0
    }
    this.prevBroad1 = broad1
    this.prevBroad2 = broad2
    // with no vertical sync heard the lines still roll through a frame.
    if (!this.fieldLock && this.lineNo >= 525) {
      this.lineNo = 0
      this.emit()
    }
  }

  private draw(edge: number): void {
    const n = this.lineNo
    let row: number
    if (n >= 22 && n <= 262) row = 2 * (n - 22)
    else if (n >= 285 && n <= 525) row = 2 * (n - 285) + 1
    else return
    if (row >= FRAME_H) return
    const start = edge + ACTIVE_START_S * this.rate
    const span = ACTIVE_S * this.rate
    const blank = this.blankT
    // white sits two and a half times the sync height under blanking.
    const scale = 1 / (2.5 * Math.max(1e-9, this.tipT - this.blankT))
    const { brightness, contrast } = this.levels
    const base = row * FRAME_W
    for (let px = 0; px < FRAME_W; px++) {
      const t = start + ((px + 0.5) / FRAME_W) * span
      const k = Math.floor(t)
      const f = t - k
      const v = this.buf[k] * (1 - f) + this.buf[k + 1] * f
      const y = ((blank - v) * scale - 0.075) / 0.925
      this.frame[base + px] = ((y - 0.5) * contrast + 0.5 + brightness) * 255
    }
  }

  private emit(): void {
    this.frames++
    this.onFrame?.(this.frame.slice())
  }
}

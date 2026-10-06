/**
 * P25 phase 1 receiver: IQ in, TSBK octets out of a control channel, or
 * LDU voice frames out of a voice channel.
 *
 * A channel filter pulls the 12.5 kHz control channel out of the window.
 * Each symbol is then read as the change of phase across it, which is what
 * C4FM's frequency deviation adds up to and what LSM, the simulcast
 * modulation, sends directly, so one receiver hears both. Reading across the
 * whole symbol rather than at one instant also rides out the smearing two
 * simulcast sites cause when both are heard.
 *
 * A Gardner loop keeps the symbol clock, the residual of each symbol from its
 * level steers out any frequency error, and the framer hunts the frame sync
 * in either polarity, reads the NID, and decodes each TSBK of a TSDU.
 *
 * On a voice channel the framer hands over each LDU's information dibits
 * for `imbe/` to turn into speech. Phase 2 voice is TDMA with AMBE+2, which
 * is still under patent and is not read here.
 */

import { ChannelFilter } from '@/core/dsp/channel'
import { Fft } from '@/core/dsp/fft'
import { LDU_DIBITS } from './imbe/ldu'
import {
  DUID,
  MAX_TSBKS,
  SYNC,
  TSBK_DIBITS,
  UNIT_HEAD_DIBITS,
  dibitOf,
  isStatusDibit,
  trellisHalfDecode,
  tsbkCrcOk,
} from './framing'

const SYMBOL_RATE = 4800
/** Half the channel, a little over the 5.8 kHz the signal fills. */
const CHANNEL_HALF_HZ = 6250
/** About ten samples a symbol, enough for the timing loop to find the eye. */
const CHANNEL_RATE = 48000
const QUARTER_PI = Math.PI / 4
/** Frame sync dibits allowed to differ before a match is refused. */
const SYNC_TOLERANCE = 3
const INVERTED_SYNC = SYNC.map((d) => d ^ 2)

/**
 * How far from its listed frequency the channel is looked for. A stick with
 * no ppm correction is often 10 ppm out, which is 8 kHz at 800 MHz, well
 * past the channel filter's edge.
 */
const SEARCH_HZ = 15_000
const ACQ_HALF_HZ = 21_000
const ACQ_SIZE = 4096
const ACQ_FRAMES = 6
/** The width a P25 signal's power mostly sits in, for finding its middle. */
const SIGNAL_WIDTH_HZ = 8_000
/** A lump this far over the floor counts as a signal. */
const ACQ_MIN_DB = 4
/** Symbols between timing checks. Clocks drift by far less than a sample in this many. */
const TIMING_EVERY = 240
/** Timing shifts tried at each check, across one symbol. */
const TIMING_STEPS = 16

/** Symbols without a new frame sync before the channel is looked for again. */
const REACQUIRE_SYMBOLS = SYMBOL_RATE * 4

export interface P25Stats {
  /** Symbols the slicer has produced. */
  symbols: number
  /** Frame syncs matched. */
  syncs: number
  /** Blocks that came out of the trellis with a good crc. */
  good: number
  /** Blocks that failed the crc, so the signal is there but marginal. */
  bad: number
  /** Mean distance of each symbol from its level, 0 is a clean eye and 1 is noise. */
  errorRate: number
  /** Most recent NAC, which identifies the system. */
  nac: number | null
  /** How far off the channel the carrier sits, in Hz, as the loop has measured it. */
  offsetHz: number
  /** The last sync matched upside down, as a spectrum inverted by the radio would. */
  inverted: boolean
  /** Looking for the channel, or reading it. */
  stage: 'acquire' | 'decode'
  /** The channel's power over the floor beside it when last looked for, in dB. */
  signalDb: number
}

export type P25Mode = 'control' | 'voice'

export interface P25Handlers {
  /** A TSBK that passed its crc, on a control channel. */
  onTsbk?: (octets: Uint8Array) => void
  /** An LDU1 or LDU2's information dibits, on a voice channel. */
  onLdu?: (duid: number, dibits: number[]) => void
  /** A terminator: the talker let go. */
  onEnd?: () => void
}

const VALID_DUIDS = [DUID.HDU, DUID.TDU, DUID.LDU1, DUID.TSDU, DUID.LDU2, DUID.PDU, DUID.TDULC]

/** The valid duid nearest a received one, since the nid's own correction is not read. */
function nearestDuid(raw: number): number {
  let best: number = raw
  let bestBits = 5
  for (const d of VALID_DUIDS) {
    let x = d ^ raw
    let bits = 0
    while (x) {
      bits += x & 1
      x >>= 1
    }
    if (bits < bestBits) {
      bestBits = bits
      best = d
    }
  }
  return best
}

/** Reads frames out of a stream of dibits. */
class Framer {
  private dibits: number[] = []
  /** Transmitted position of `dibits[0]`, counted from the last matched sync. */
  private framePos = 0
  private inUnit = false
  private blocksLeft = 0
  private firstBlock = false
  /** Inside a voice frame, waiting for this duid's dibits. */
  private ldu: number | null = null
  private invert = false

  constructor(
    private readonly stats: P25Stats,
    private readonly mode: P25Mode,
    private readonly handlers: P25Handlers,
  ) {}

  reset(): void {
    this.dibits.length = 0
    this.framePos = 0
    this.inUnit = false
    this.blocksLeft = 0
    this.ldu = null
  }

  push(dibit: number): void {
    this.dibits.push(this.invert ? dibit ^ 2 : dibit)
    if (this.dibits.length > 4096) {
      const drop = this.dibits.length - 2048
      this.dibits.splice(0, drop)
      this.framePos += drop
    }
    this.hunt()
  }

  /**
   * A unit arrives a symbol at a time, so once a sync is read the framer
   * stays in the unit and takes each block as it completes.
   */
  private hunt(): void {
    const d = this.dibits
    if (this.ldu !== null) {
      const body = this.takeInfo(LDU_DIBITS)
      if (!body) return
      const duid = this.ldu
      this.ldu = null
      this.stats.good++
      this.handlers.onLdu?.(duid, body)
      return
    }
    if (this.inUnit) {
      while (this.blocksLeft > 0) {
        const block = this.takeInfo(TSBK_DIBITS)
        if (!block) break
        const octets = trellisHalfDecode(block)
        this.blocksLeft--
        if (!octets) break
        const first = this.firstBlock
        this.firstBlock = false
        if (tsbkCrcOk(octets)) {
          this.stats.good++
          this.handlers.onTsbk?.(octets)
        } else if (first) {
          // the unit was taken on trust, and its first block says it was not a tsdu.
          this.blocksLeft = 0
          break
        } else {
          this.stats.bad++
        }
        // bit 7 of the first octet marks the last block in the unit.
        if (octets[0] & 0x80) this.blocksLeft = 0
      }
      if (this.blocksLeft === 0) this.inUnit = false
      return
    }

    if (d.length < UNIT_HEAD_DIBITS) return
    // the newest sync can only end where the buffer ends, so only that window is new.
    const start = d.length - UNIT_HEAD_DIBITS
    const upright = mismatches(d, start, SYNC)
    const flipped = mismatches(d, start, this.invert ? SYNC : INVERTED_SYNC)
    if (upright > SYNC_TOLERANCE && flipped > SYNC_TOLERANCE) {
      if (d.length > UNIT_HEAD_DIBITS * 2) {
        const drop = d.length - UNIT_HEAD_DIBITS * 2
        d.splice(0, drop)
        this.framePos += drop
      }
      return
    }
    if (upright > SYNC_TOLERANCE) {
      // the stream is upside down: flip what is held and everything after.
      for (let i = start; i < d.length; i++) d[i] ^= 2
      this.invert = !this.invert
    }
    this.stats.inverted = this.invert

    const nidAt = start + SYNC.length
    // the nac and the duid sit ahead of the status dibit at position 35.
    let head = 0
    for (let i = 0; i < 8; i++) head = (head << 2) | (d[nidAt + i] & 3)
    this.stats.syncs++
    this.stats.nac = (head >> 4) & 0xfff
    const duid = head & 0xf

    d.splice(0, start + UNIT_HEAD_DIBITS)
    this.framePos = UNIT_HEAD_DIBITS
    if (this.mode === 'voice') {
      const unit = nearestDuid(duid)
      if (unit === DUID.LDU1 || unit === DUID.LDU2) {
        this.ldu = unit
        this.hunt()
      } else if (unit === DUID.TDU || unit === DUID.TDULC) this.handlers.onEnd?.()
      return
    }
    // the duid has no error correction here, and one wrong symbol turns a
    // tsdu into something else. a control channel sends little but tsdus, so
    // anything but a data packet is read as one and dropped if its first
    // block fails.
    if (duid !== DUID.PDU) {
      this.inUnit = true
      this.blocksLeft = MAX_TSBKS
      this.firstBlock = duid !== DUID.TSDU
      this.hunt()
    }
  }

  /** The next information dibits, skipping status positions, or null if not all here yet. */
  private takeInfo(count: number): number[] | null {
    const d = this.dibits
    const block: number[] = []
    let taken = 0
    while (block.length < count) {
      if (taken >= d.length) return null
      if (!isStatusDibit(this.framePos + taken)) block.push(d[taken])
      taken++
    }
    d.splice(0, taken)
    this.framePos += taken
    return block
  }
}

function mismatches(d: number[], at: number, pattern: number[]): number {
  let wrong = 0
  for (let i = 0; i < pattern.length; i++) if (d[at + i] !== pattern[i] && ++wrong > SYNC_TOLERANCE) break
  return wrong
}

/**
 * The whole path from a radio's IQ to frames. Feed it the window as it
 * comes, and tell it where in the window the channel sits.
 */
export class P25Receiver {
  private filter: ChannelFilter | null = null
  private inputRate = 0
  private offset = 0
  private sps = 10

  // acquisition: a wider look around the listed frequency to find the channel.
  private wide: ChannelFilter | null = null
  private readonly fft = new Fft(ACQ_SIZE)
  private readonly acqRe = new Float32Array(ACQ_SIZE)
  private readonly acqIm = new Float32Array(ACQ_SIZE)
  private readonly acqPow = new Float64Array(ACQ_SIZE)
  private acqFill = 0
  private acqFrames = 0
  /** Where the channel was found, in Hz from the listed frequency. */
  private found = 0
  private syncsAtCheck = 0
  private symbolsAtCheck = 0
  /** The radio's error, when given, so no search is needed. */
  private known: number | null = null

  // the unwrapped phase of the channel, one entry per channel sample.
  private phase: number[] = []
  private acc = 0
  private prevI = 1
  private prevQ = 0
  /** Phase the carrier adds each sample, which the loop takes back out. */
  private bias = 0
  /** Where the next symbol is read, in channel samples into `phase`. */
  private t = 0
  /** Where each recent symbol was read, for the timing check. */
  private recent: number[] = []
  /** Share of recent symbols that sat on a level at the last timing check, 0 to 1. */
  private eye = 0
  private errAcc = 1
  /**
   * Mean size of a symbol's turn, in level units. Balanced symbols average
   * 2, so the ratio corrects a transmitter whose deviation is off standard.
   */
  private spread = 2

  private readonly stats: P25Stats = {
    symbols: 0,
    syncs: 0,
    good: 0,
    bad: 0,
    errorRate: 1,
    nac: null,
    offsetHz: 0,
    inverted: false,
    stage: 'acquire',
    signalDb: 0,
  }
  private readonly framer: Framer

  constructor(handlers: P25Handlers, mode: P25Mode = 'control') {
    this.framer = new Framer(this.stats, mode, handlers)
  }

  /**
   * Where the channel sits inside the window, in Hz from its centre. With
   * `errorHz`, the radio's error already measured elsewhere, the channel is
   * read there at once rather than looked for, which a voice channel that
   * is quiet between calls needs.
   */
  setOffset(hz: number, errorHz?: number): void {
    if (hz === this.offset && (this.filter || this.wide) && errorHz === undefined) return
    this.offset = hz
    this.known = errorHz ?? null
    this.rebuild()
  }

  getStats(): P25Stats {
    const fineHz = this.stats.stage === 'decode' ? (this.bias * this.channelRate()) / (2 * Math.PI) : 0
    return { ...this.stats, offsetHz: this.found + fineHz }
  }

  private channelRate(): number {
    return this.filter?.outRate ?? CHANNEL_RATE
  }

  /** Starts looking for the channel around the listed frequency. */
  private rebuild(): void {
    if (!this.inputRate) return
    if (this.known !== null) {
      this.found = Math.round(this.known)
      this.lock()
      return
    }
    this.wide = new ChannelFilter(this.offset, this.inputRate, ACQ_HALF_HZ, CHANNEL_RATE)
    this.filter = null
    this.acqFill = 0
    this.acqFrames = 0
    this.acqPow.fill(0)
    this.found = 0
    this.stats.stage = 'acquire'
  }

  /** Decodes the channel where it was found. */
  private lock(): void {
    this.filter = new ChannelFilter(this.offset + this.found, this.inputRate, CHANNEL_HALF_HZ, CHANNEL_RATE)
    this.sps = this.filter.outRate / SYMBOL_RATE
    this.phase.length = 0
    this.acc = 0
    this.bias = 0
    this.t = 2 * this.sps
    this.recent.length = 0
    this.eye = 0
    this.spread = 2
    this.framer.reset()
    this.wide = null
    this.stats.stage = 'decode'
    this.syncsAtCheck = this.stats.syncs
    this.symbolsAtCheck = this.stats.symbols
  }

  /** One wide sample in. When enough are in, finds the channel's middle. */
  private acquire(i: number, q: number): void {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * this.acqFill) / ACQ_SIZE)
    this.acqRe[this.acqFill] = i * w
    this.acqIm[this.acqFill] = q * w
    if (++this.acqFill < ACQ_SIZE) return
    this.acqFill = 0
    this.fft.transform(this.acqRe, this.acqIm)
    for (let k = 0; k < ACQ_SIZE; k++) this.acqPow[k] += this.acqRe[k] ** 2 + this.acqIm[k] ** 2
    if (++this.acqFrames < ACQ_FRAMES) return

    const rate = this.wide?.outRate ?? CHANNEL_RATE
    const binHz = rate / ACQ_SIZE
    const at = (hz: number) => this.acqPow[((Math.round(hz / binHz) % ACQ_SIZE) + ACQ_SIZE) % ACQ_SIZE]
    const half = Math.round(SIGNAL_WIDTH_HZ / 2 / binHz)
    const all: number[] = []
    for (let hz = -ACQ_HALF_HZ; hz <= ACQ_HALF_HZ; hz += binHz) all.push(at(hz))
    all.sort((a, b) => a - b)
    const floor = all[Math.floor(all.length / 4)] || 1e-30
    let best = -1
    let bestHz = 0
    for (let hz = -SEARCH_HZ; hz <= SEARCH_HZ; hz += binHz) {
      let sum = 0
      for (let k = -half; k <= half; k++) sum += at(hz + k * binHz)
      if (sum > best) {
        best = sum
        bestHz = hz
      }
    }
    this.stats.signalDb = 10 * Math.log10(best / (2 * half + 1) / floor)
    this.acqFrames = 0
    this.acqPow.fill(0)
    if (this.stats.signalDb < ACQ_MIN_DB) return
    this.found = Math.round(bestHz)
    this.lock()
  }

  feed(iq: Float32Array, sampleRate: number): void {
    if (sampleRate !== this.inputRate) {
      this.inputRate = sampleRate
      this.rebuild()
    }
    const wide = this.wide
    if (wide) {
      for (let n = 0; n + 1 < iq.length; n += 2) {
        if (wide.push(iq[n], iq[n + 1])) this.acquire(wide.outI, wide.outQ)
        if (!this.wide) break
      }
      return
    }
    const f = this.filter
    if (!f) return
    for (let n = 0; n + 1 < iq.length; n += 2) {
      if (!f.push(iq[n], iq[n + 1])) continue
      const i = f.outI
      const q = f.outQ
      // the phase step since the last sample, less what the carrier offset adds.
      const step = Math.atan2(q * this.prevI - i * this.prevQ, i * this.prevI + q * this.prevQ)
      this.prevI = i
      this.prevQ = q
      this.acc += step - this.bias
      this.phase.push(this.acc)
    }
    this.symbols()
  }

  /**
   * Finds the reading point with the cleanest eye over the recent symbols
   * and moves the clock to it. A search holds where a tracking loop is
   * pulled off by the smearing real transmitters and simulcast add.
   */
  private retime(): void {
    const sps = this.sps
    let best = -1
    let bestShift = 0
    for (let k = 0; k < TIMING_STEPS; k++) {
      const shift = ((k / TIMING_STEPS) - 0.5) * sps
      let fit = 0
      for (const t of this.recent) {
        const y = this.level(t + shift)
        const n = y > 2 ? 3 : y > 0 ? 1 : y > -2 ? -1 : -3
        fit += Math.max(0, 1 - Math.abs(y - n))
      }
      if (fit > best) {
        best = fit
        bestShift = shift
      }
    }
    this.eye = best / this.recent.length
    // half the way at a time, so one noisy stretch cannot throw the clock.
    this.t += bestShift / 2
    this.recent.length = 0
  }

  /** Phase at a fractional sample position. */
  private at(pos: number): number {
    const k = Math.floor(pos)
    const fr = pos - k
    const a = this.phase[k] ?? 0
    const b = this.phase[k + 1] ?? a
    return a + (b - a) * fr
  }

  /** The level a symbol ending at pos carried, from the phase it turned through. */
  private level(pos: number): number {
    return ((this.at(pos) - this.at(pos - this.sps)) / QUARTER_PI) * (2 / this.spread)
  }

  private symbols(): void {
    const sps = this.sps
    while (this.t + 1 < this.phase.length) {
      const y = this.level(this.t)
      // the spread is measured on the scaled level, so it settles where the levels average 2.
      this.spread = Math.max(0.5, Math.min(8, this.spread * (1 + 0.0005 * (Math.abs(y) / 2 - 1))))
      this.recent.push(this.t)

      const dibit = dibitOf(y)
      const ideal = dibit === 1 ? 3 : dibit === 0 ? 1 : dibit === 2 ? -1 : -3
      const r = y - ideal
      // a carrier off frequency adds the same turn to every symbol. with the
      // eye open each symbol's distance from its level measures it. until
      // then only the average can, and real data is too unbalanced for the
      // average to be trusted quickly, so that pull is slow.
      const pull = this.eye > 0.6 ? 0.001 * r : 0.001 * y
      const limit = (2 * Math.PI * CHANNEL_HALF_HZ) / this.channelRate() / 2
      this.bias = Math.max(-limit, Math.min(limit, this.bias + (pull * QUARTER_PI) / sps))
      this.errAcc += 0.002 * (Math.min(1, Math.abs(r)) - this.errAcc)
      this.stats.errorRate = this.errAcc
      this.stats.symbols++
      this.framer.push(dibit)

      this.t += sps
      if (this.recent.length >= TIMING_EVERY) this.retime()
    }
    // no frame for a while means the lock was on the wrong thing, or the channel moved.
    if (this.known === null && this.stats.symbols - this.symbolsAtCheck > REACQUIRE_SYMBOLS) {
      if (this.stats.syncs === this.syncsAtCheck) {
        this.rebuild()
        return
      }
      this.syncsAtCheck = this.stats.syncs
      this.symbolsAtCheck = this.stats.symbols
    }
    // keep the symbols the timing check reads behind the clock.
    const keep = Math.floor(this.t - (TIMING_EVERY + 4) * sps)
    if (keep > 4096) {
      this.phase.splice(0, keep)
      this.t -= keep
    }
  }
}

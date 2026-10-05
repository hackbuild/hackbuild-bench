/**
 * P25 phase 1 control channel receiver: IQ in, TSBK octets out.
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
 * Voice is out of reach: LDU frames carry IMBE, and phase 2 voice is TDMA
 * with AMBE, and this build has neither vocoder.
 */

import { ChannelFilter } from '@/core/dsp/channel'
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
}

/** Reads frames out of a stream of dibits. */
class Framer {
  private dibits: number[] = []
  /** Transmitted position of `dibits[0]`, counted from the last matched sync. */
  private framePos = 0
  private inUnit = false
  private blocksLeft = 0
  private firstBlock = false
  private invert = false

  constructor(
    private readonly stats: P25Stats,
    private readonly onTsbk: (octets: Uint8Array) => void,
  ) {}

  reset(): void {
    this.dibits.length = 0
    this.framePos = 0
    this.inUnit = false
    this.blocksLeft = 0
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
    if (this.inUnit) {
      while (this.blocksLeft > 0) {
        const block = this.takeBlock()
        if (!block) break
        const octets = trellisHalfDecode(block)
        this.blocksLeft--
        if (!octets) break
        const first = this.firstBlock
        this.firstBlock = false
        if (tsbkCrcOk(octets)) {
          this.stats.good++
          this.onTsbk(octets)
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

  /** The next 98 information dibits, skipping status positions, or null if not all here yet. */
  private takeBlock(): number[] | null {
    const d = this.dibits
    const block: number[] = []
    let taken = 0
    while (block.length < TSBK_DIBITS) {
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
 * The whole path from a radio's IQ to TSBKs. Feed it the window as it comes,
 * and tell it where in the window the control channel sits.
 */
export class ControlChannelDecoder {
  private filter: ChannelFilter | null = null
  private inputRate = 0
  private offset = 0
  private sps = 10

  // the unwrapped phase of the channel, one entry per channel sample.
  private phase: number[] = []
  private acc = 0
  private prevI = 1
  private prevQ = 0
  /** Phase the carrier adds each sample, which the loop takes back out. */
  private bias = 0
  /** Where the next symbol is read, in channel samples into `phase`. */
  private t = 0
  private yPrev = 0
  private errAcc = 1

  private readonly stats: P25Stats = {
    symbols: 0,
    syncs: 0,
    good: 0,
    bad: 0,
    errorRate: 1,
    nac: null,
    offsetHz: 0,
    inverted: false,
  }
  private readonly framer: Framer

  constructor(onTsbk: (octets: Uint8Array) => void) {
    this.framer = new Framer(this.stats, onTsbk)
  }

  /** Where the control channel sits inside the window, in Hz from its centre. */
  setOffset(hz: number): void {
    if (hz === this.offset && this.filter) return
    this.offset = hz
    this.rebuild()
  }

  getStats(): P25Stats {
    return { ...this.stats, offsetHz: (this.bias * this.channelRate()) / (2 * Math.PI) }
  }

  private channelRate(): number {
    return this.filter?.outRate ?? CHANNEL_RATE
  }

  private rebuild(): void {
    if (!this.inputRate) return
    this.filter = new ChannelFilter(this.offset, this.inputRate, CHANNEL_HALF_HZ, CHANNEL_RATE)
    this.sps = this.filter.outRate / SYMBOL_RATE
    this.phase.length = 0
    this.acc = 0
    this.bias = 0
    this.t = 2 * this.sps
    this.framer.reset()
  }

  feed(iq: Float32Array, sampleRate: number): void {
    if (sampleRate !== this.inputRate) {
      this.inputRate = sampleRate
      this.rebuild()
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
    return (this.at(pos) - this.at(pos - this.sps)) / QUARTER_PI
  }

  private symbols(): void {
    const sps = this.sps
    while (this.t + 1 < this.phase.length) {
      const y = this.level(this.t)
      const mid = this.level(this.t - sps / 2)
      // gardner: the half way reading sits on zero when the clock is on the eye.
      const err = Math.max(-1, Math.min(1, ((this.yPrev - y) * mid) / 18))
      this.yPrev = y

      const dibit = dibitOf(y)
      const ideal = dibit === 1 ? 3 : dibit === 0 ? 1 : dibit === 2 ? -1 : -3
      const r = y - ideal
      // a carrier off frequency adds the same turn to every symbol, and the
      // symbols themselves average to none. steering on the average rather
      // than on the sliced residual holds even when the offset is large
      // enough to slice every symbol wrong.
      this.bias += 0.004 * ((y * QUARTER_PI) / sps)
      this.errAcc += 0.002 * (Math.min(1, Math.abs(r)) - this.errAcc)
      this.stats.errorRate = this.errAcc
      this.stats.symbols++
      this.framer.push(dibit)

      this.t += sps + 0.08 * err * sps
    }
    // keep a few symbols of history behind the clock.
    const keep = Math.floor(this.t - 3 * sps)
    if (keep > 4096) {
      this.phase.splice(0, keep)
      this.t -= keep
    }
  }
}

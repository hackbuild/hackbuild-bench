/**
 * P25 phase 1 control channel receiver: IQ in, TSBK octets out.
 *
 * The chain is the ordinary one. Discriminate the FM, recover the 4800 baud
 * symbol clock, slice each symbol to a dibit against tracked levels, hunt the
 * frame sync, read the NID for the NAC and the data unit type, and for a TSDU
 * deinterleave and Viterbi decode each block back to the twelve octets that
 * `parseTsbk` reads.
 *
 * Voice is deliberately not attempted. LDU frames carry IMBE, which needs a
 * vocoder this build does not have, so a followed call shows as activity
 * rather than audio.
 *
 * The trellis constellation, the deinterleave order and the sync pattern
 * follow TIA-102.BAAA as implemented by op25.
 */

import { Downconverter, FmDemod } from '@/core/dsp/demod'

const SYMBOL_RATE = 4800

/** Ten samples a symbol, enough for the timing loop to sit on the eye. */
const TARGET_IF = SYMBOL_RATE * 10

/** 0x5575F5FF77FF as dibits. Only the outer two levels appear in it. */
const SYNC = [1, 1, 1, 1, 1, 3, 1, 1, 3, 3, 1, 1, 3, 3, 3, 3, 1, 3, 1, 3, 3, 3, 3, 3]

/** Dibit to nominal deviation, in units where the outer symbols are +-3. */
const LEVEL: Record<number, number> = { 1: 3, 0: 1, 2: -1, 3: -3 }

const NID_DIBITS = 32
const TSBK_DIBITS = 98
const MAX_TSBKS = 3

export const DUID = {
  HDU: 0x0,
  TDU: 0x3,
  LDU1: 0x5,
  TSDU: 0x7,
  LDU2: 0xa,
  PDU: 0xc,
  TDULC: 0xf,
} as const

/** Half rate trellis: output constellation indexed by [state][input dibit]. */
const TRELLIS_HALF = [
  [0, 15, 12, 3],
  [4, 11, 8, 7],
  [13, 2, 1, 14],
  [9, 6, 5, 10],
]

/** Dibit order the half rate blocks are interleaved in. */
const DEINTERLEAVE = [
  0, 1, 8, 9, 16, 17, 24, 25, 32, 33, 40, 41, 48, 49, 56, 57, 64, 65, 72, 73, 80, 81, 88,
  89, 96, 97, 2, 3, 10, 11, 18, 19, 26, 27, 34, 35, 42, 43, 50, 51, 58, 59, 66, 67, 74,
  75, 82, 83, 90, 91, 4, 5, 12, 13, 20, 21, 28, 29, 36, 37, 44, 45, 52, 53, 60, 61, 68,
  69, 76, 77, 84, 85, 92, 93, 6, 7, 14, 15, 22, 23, 30, 31, 38, 39, 46, 47, 54, 55, 62,
  63, 70, 71, 78, 79, 86, 87, 94, 95,
]

function popcount4(v: number): number {
  return (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1)
}

/**
 * Viterbi over the half rate trellis. 98 dibits in, 12 octets out.
 *
 * Each pair of received dibits is one four bit constellation point. Four
 * states, one step per point, branch metric is the Hamming distance to what
 * the encoder would have produced.
 */
export function trellisHalfDecode(dibits: Int8Array | number[]): Uint8Array | null {
  if (dibits.length < TSBK_DIBITS) return null

  const deint = new Int8Array(TSBK_DIBITS)
  for (let i = 0; i < TSBK_DIBITS; i++) deint[i] = dibits[DEINTERLEAVE[i]]

  const steps = TSBK_DIBITS / 2
  const cost = [0, 1e9, 1e9, 1e9]
  const back = new Uint8Array(steps * 4)

  for (let step = 0; step < steps; step++) {
    // two dibits make the four bit point, first dibit is the high pair.
    const point = ((deint[step * 2] & 3) << 2) | (deint[step * 2 + 1] & 3)
    const next = [1e9, 1e9, 1e9, 1e9]
    for (let from = 0; from < 4; from++) {
      if (cost[from] >= 1e9) continue
      for (let input = 0; input < 4; input++) {
        const metric = cost[from] + popcount4(TRELLIS_HALF[from][input] ^ point)
        // the next state is the input, which is what makes the traceback easy.
        if (metric < next[input]) {
          next[input] = metric
          back[step * 4 + input] = from
        }
      }
    }
    for (let i = 0; i < 4; i++) cost[i] = next[i]
  }

  // the encoder flushes to state zero, so the survivor ends there.
  let state = 0
  const inputs = new Uint8Array(steps)
  for (let step = steps - 1; step >= 0; step--) {
    inputs[step] = state
    state = back[step * 4 + state]
  }

  // the last input is the flush, the other 48 dibits are the 12 octets.
  const out = new Uint8Array(12)
  for (let i = 0; i < 48; i++) {
    out[i >> 2] = ((out[i >> 2] << 2) | (inputs[i] & 3)) & 0xff
  }
  return out
}

/** CRC-CCITT over the first ten octets, which is what a TSBK carries. */
export function tsbkCrcOk(octets: Uint8Array): boolean {
  let crc = 0xffff
  for (let i = 0; i < 10; i++) {
    crc ^= octets[i] << 8
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  crc = (~crc) & 0xffff
  return octets[10] === ((crc >> 8) & 0xff) && octets[11] === (crc & 0xff)
}

export interface C4fmStats {
  /** Symbols the slicer has produced. */
  symbols: number
  /** Frame syncs matched. */
  syncs: number
  /** Blocks that came out of the trellis with a good crc. */
  good: number
  /** Blocks that failed the crc, so the signal is there but marginal. */
  bad: number
  /** Mean distance of each symbol from its slicing level, 0 is a clean eye. */
  errorRate: number
  /** Most recent NAC, which identifies the system. */
  nac: number | null
}

/**
 * Turns a stream of discriminator samples into TSBKs.
 *
 * Feed it real valued FM discriminator output at `sampleRate`. It owns the
 * symbol clock, so chunk boundaries do not matter.
 */
export class C4fmReceiver {
  private sps: number
  private mu = 0
  private prevSym = 0
  private history: number[] = []
  private centre = 0
  private spread = 1
  private dibits: number[] = []
  private stats: C4fmStats = {
    symbols: 0,
    syncs: 0,
    good: 0,
    bad: 0,
    errorRate: 1,
    nac: null,
  }
  private errAcc = 1
  /** True between reading a TSDU header and finishing its blocks. */
  private inUnit = false
  private blocksLeft = 0
  private onTsbk: (octets: Uint8Array) => void

  constructor(sampleRate: number, onTsbk: (octets: Uint8Array) => void) {
    this.sps = sampleRate / SYMBOL_RATE
    this.onTsbk = onTsbk
  }

  setSampleRate(sampleRate: number): void {
    this.sps = sampleRate / SYMBOL_RATE
    this.history.length = 0
    this.dibits.length = 0
    this.mu = 0
    this.inUnit = false
    this.blocksLeft = 0
  }

  getStats(): C4fmStats {
    return { ...this.stats }
  }

  /**
   * Discriminator samples in. The symbol clock runs across calls, so a chunk
   * that ends mid symbol carries over.
   */
  feed(x: Float32Array): void {
    // keep the tail of the previous chunk so interpolation can look back.
    const h = this.history
    for (let i = 0; i < x.length; i++) h.push(x[i])

    while (this.mu + this.sps + 2 < h.length) {
      const centreAt = this.mu + this.sps
      const halfAt = this.mu + this.sps / 2
      const sym = interp(h, centreAt)
      const half = interp(h, halfAt)

      // gardner: the error is the half symbol sample weighted by the slope
      // across it, which is zero when the clock sits on the eye.
      const err = half * (sym - this.prevSym)
      const scale = Math.max(1e-6, this.spread * this.spread)
      this.mu = centreAt - 0.02 * (err / scale) * this.sps
      this.prevSym = sym

      this.pushSymbol(sym)
    }

    // drop what the clock has already passed, keeping a little context.
    const drop = Math.max(0, Math.floor(this.mu) - 4)
    if (drop > 0) {
      h.splice(0, drop)
      this.mu -= drop
    }
    if (h.length > 1 << 16) h.splice(0, h.length - (1 << 15))
  }

  /** Track the eye, slice to a dibit, and hand it to the framer. */
  private pushSymbol(sym: number): void {
    // the centre follows any tuning error, the spread follows the deviation.
    this.centre += 0.0005 * (sym - this.centre)
    const d = sym - this.centre
    // a balanced stream averages 1200 Hz of deviation, halfway between the
    // inner and outer symbols, which is exactly the slicing threshold.
    this.spread += 0.001 * (Math.abs(d) - this.spread)
    const t = Math.max(1e-9, this.spread)

    let dibit: number
    if (d > t) dibit = 1
    else if (d > 0) dibit = 0
    else if (d > -t) dibit = 2
    else dibit = 3

    // how far the symbol sat from where its level should be, 0 is a clean eye.
    const ideal = (LEVEL[dibit] * t) / 2
    this.errAcc += 0.001 * (Math.min(1, Math.abs(d - ideal) / (2 * t)) - this.errAcc)
    this.stats.errorRate = this.errAcc
    this.stats.symbols++

    this.dibits.push(dibit)
    if (this.dibits.length > 4096) this.dibits.splice(0, this.dibits.length - 2048)
    this.hunt()
  }

  /**
   * Look for a frame sync, then read the data unit behind it.
   *
   * A unit arrives a symbol at a time, so this cannot decode everything the
   * moment a sync lands: only the first block would be in the buffer and the
   * rest of the unit would be thrown away with it. Once a sync is read the
   * framer stays in the unit and takes each block as it completes.
   */
  private hunt(): void {
    const d = this.dibits

    if (this.inUnit) {
      while (this.blocksLeft > 0 && d.length >= TSBK_DIBITS) {
        const octets = trellisHalfDecode(d.slice(0, TSBK_DIBITS))
        d.splice(0, TSBK_DIBITS)
        this.blocksLeft--
        if (!octets) break
        if (tsbkCrcOk(octets)) {
          this.stats.good++
          this.onTsbk(octets)
        } else {
          this.stats.bad++
        }
        // bit 7 of the first octet marks the last block in the unit.
        if (octets[0] & 0x80) this.blocksLeft = 0
      }
      if (this.blocksLeft === 0) this.inUnit = false
      return
    }

    const window = SYNC.length + NID_DIBITS
    if (d.length < window) return

    const last = d.length - window
    for (let start = 0; start <= last; start++) {
      let wrong = 0
      for (let i = 0; i < SYNC.length; i++) {
        if (d[start + i] !== SYNC[i] && ++wrong > 2) break
      }
      if (wrong > 2) continue

      const nidAt = start + SYNC.length
      // the first sixteen bits of the nid are the nac then the duid. the rest
      // is bch parity, which a failed crc downstream catches anyway.
      let head = 0
      for (let i = 0; i < 8; i++) head = (head << 2) | (d[nidAt + i] & 3)
      const nac = (head >> 4) & 0xfff
      const duid = head & 0xf
      this.stats.syncs++
      this.stats.nac = nac

      d.splice(0, nidAt + NID_DIBITS)
      if (duid === DUID.TSDU) {
        this.inUnit = true
        this.blocksLeft = MAX_TSBKS
        this.hunt()
      }
      return
    }

    // nothing matched. keep enough for a sync that straddles the next chunk.
    if (d.length > window * 2) d.splice(0, d.length - window * 2)
  }
}

function interp(h: number[], pos: number): number {
  const i = Math.floor(pos)
  const f = pos - i
  const a = h[i] ?? 0
  const b = h[i + 1] ?? a
  return a + (b - a) * f
}

/**
 * The whole path from a radio's IQ to TSBKs.
 *
 * The control channel is one narrow signal in whatever window the radio is
 * handing over, so this shifts it to baseband, decimates onto a symbol clock
 * friendly rate, discriminates the FM and hands the result to the framer.
 */
export class ControlChannelDecoder {
  private down = new Downconverter()
  private fm = new FmDemod()
  private rx: C4fmReceiver
  private inputRate = 0
  private offset = 0

  constructor(onTsbk: (octets: Uint8Array) => void) {
    this.rx = new C4fmReceiver(TARGET_IF, onTsbk)
  }

  /** Where the control channel sits inside the window, in Hz from its centre. */
  setOffset(hz: number): void {
    this.offset = hz
    if (this.inputRate) this.retune()
  }

  private retune(): void {
    const factor = Math.max(1, Math.round(this.inputRate / TARGET_IF))
    const ifRate = this.inputRate / factor
    this.down.configure(factor, this.offset, this.inputRate)
    this.fm.configure(3000, ifRate)
    this.rx.setSampleRate(ifRate)
  }

  feed(iq: Float32Array, sampleRate: number): void {
    if (sampleRate !== this.inputRate) {
      this.inputRate = sampleRate
      this.retune()
    }
    const base = this.down.process(iq)
    if (!base.length) return
    this.rx.feed(this.fm.process(base))
  }

  getStats(): C4fmStats {
    return this.rx.getStats()
  }
}

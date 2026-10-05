/**
 * MSK bit recovery and block framing for one ACARS channel.
 *
 * Input is the AM envelope of one channel. ACARS keys 1200 and 2400 Hz audio
 * tones at 2400 baud, which is MSK centred on 1800 Hz. A VCO at 1800 Hz mixes
 * the envelope down, a half cosine matched filter integrates each bit, and a
 * PLL steers the VCO from the quadrature arm.
 *
 * The loop constants, the filter and the framer states follow acarsdec 3.7
 * (Thierry Leconte, LGPL-2) at its 12500 Hz work rate. Other rates scale the
 * filter length and the VCO step, which acarsdec never does.
 */

import { DLE, ETB, ETX, MAX_BLOCK, MAX_PARITY_ERRORS, SOH, SYN } from './frame'
import type { RawBlock } from './frame'

const CENTER_HZ = 1800
const BIT_HZ = 1200
/** Matched filter taps are oversampled so the bit clock can pick a phase. */
const OVER = 12
const PLL_G = 38e-4
const PLL_C = 0.52
const TWO_PI = 2 * Math.PI
const CLOCK_WRAP = (3 * Math.PI) / 2

const State = {
  WaitSyn: 0,
  Syn2: 1,
  Soh: 2,
  Text: 3,
  Crc1: 4,
  Crc2: 5,
  End: 6,
} as const
type State = (typeof State)[keyof typeof State]

export class MskChannel {
  readonly rate: number
  onBlock: ((b: RawBlock) => void) | null = null

  private readonly flen: number
  private readonly h: Float32Array
  private readonly inRe: Float32Array
  private readonly inIm: Float32Array
  private readonly step0: number

  private idx = 0
  private phi = 0
  private df = 0
  private clk = 0
  private s = 0
  private lvlSum = 0
  private bitCount = 0

  private outbits = 0
  private nbits = 8
  private state: State = State.WaitSyn
  private txt = new Uint8Array(MAX_BLOCK + 2)
  private len = 0
  private err = 0
  private crc0 = 0
  private startAt = 0
  /** Samples consumed before the current call, the channel's own clock. */
  private n = 0
  private at = 0

  constructor(rate: number) {
    this.rate = rate
    this.flen = Math.floor(rate / BIT_HZ) + 1
    const fleno = this.flen * OVER + 1
    this.h = new Float32Array(fleno)
    for (let i = 0; i < fleno; i++) {
      const v = Math.cos(((TWO_PI * 600) / rate / OVER) * (i - (fleno - 1) / 2))
      this.h[i] = v < 0 ? 0 : v
    }
    this.inRe = new Float32Array(this.flen)
    this.inIm = new Float32Array(this.flen)
    this.step0 = (CENTER_HZ / rate) * TWO_PI
  }

  reset(): void {
    this.idx = 0
    this.phi = 0
    this.df = 0
    this.clk = 0
    this.s = 0
    this.inRe.fill(0)
    this.inIm.fill(0)
    this.outbits = 0
    this.nbits = 8
    this.state = State.WaitSyn
    this.len = 0
    this.n = 0
  }

  process(env: Float32Array, count = env.length): void {
    const flen = this.flen
    const h = this.h
    const inRe = this.inRe
    const inIm = this.inIm
    let idx = this.idx
    let p = this.phi

    for (let n = 0; n < count; n++) {
      const s = this.step0 + this.df
      p += s
      if (p >= TWO_PI) p -= TWO_PI

      const x = env[n]
      inRe[idx] = x * Math.cos(p)
      inIm[idx] = -x * Math.sin(p)
      idx = idx + 1 === flen ? 0 : idx + 1

      this.clk = Math.fround(this.clk + s)
      if (this.clk >= CLOCK_WRAP - s / 2) {
        this.clk = Math.fround(this.clk - CLOCK_WRAP)

        let o = Math.trunc(OVER * (this.clk / s + 0.5))
        if (o > OVER) o = OVER
        let vr = 0
        let vi = 0
        let k = idx
        for (let j = 0; j < flen; j++, o += OVER) {
          vr += h[o] * inRe[k]
          vi += h[o] * inIm[k]
          k = k + 1 === flen ? 0 : k + 1
        }

        const lvl = Math.hypot(vr, vi)
        vr /= lvl + 1e-8
        vi /= lvl + 1e-8
        this.lvlSum += (lvl * lvl) / 4
        this.bitCount++

        let vo: number
        let dphi: number
        if (this.s & 1) {
          vo = vi
          dphi = vo >= 0 ? -vr : vr
        } else {
          vo = vr
          dphi = vo >= 0 ? vi : -vi
        }
        this.at = this.n + n
        this.putBit(this.s & 2 ? -vo : vo)
        this.s++

        this.df = PLL_C * this.df + (1 - PLL_C) * PLL_G * dphi
      }
    }

    this.idx = idx
    this.phi = p
    this.n += count
  }

  private putBit(v: number): void {
    this.outbits >>= 1
    if (v > 0) this.outbits |= 0x80
    this.nbits--
    if (this.nbits <= 0) this.frame()
  }

  private restart(): void {
    this.state = State.WaitSyn
    this.df = 0
    this.nbits = 1
  }

  private frame(): void {
    const r = this.outbits
    switch (this.state) {
      case State.WaitSyn:
        if (r === SYN) {
          this.state = State.Syn2
          this.nbits = 8
          return
        }
        if (r === (~SYN & 0xff)) {
          this.s ^= 2
          this.state = State.Syn2
          this.nbits = 8
          return
        }
        this.nbits = 1
        return
      case State.Syn2:
        if (r === SYN) {
          this.state = State.Soh
          this.nbits = 8
          return
        }
        if (r === (~SYN & 0xff)) {
          this.s ^= 2
          this.nbits = 8
          return
        }
        this.restart()
        return
      case State.Soh:
        if (r === SOH) {
          this.state = State.Text
          this.len = 0
          this.err = 0
          this.nbits = 8
          this.lvlSum = 0
          this.bitCount = 0
          this.startAt = this.at
          return
        }
        this.restart()
        return
      case State.Text: {
        this.txt[this.len++] = r
        if (!oddParity(r)) {
          this.err++
          if (this.err > MAX_PARITY_ERRORS + 1) {
            this.restart()
            return
          }
        }
        if (r === ETX || r === ETB) {
          this.state = State.Crc1
          this.nbits = 8
          return
        }
        if (this.len > 20 && r === DLE) {
          // the terminator was lost, so the last three characters read are
          // the two crc bytes and the DLE that follows them.
          this.len -= 3
          this.emit(this.txt[this.len], this.txt[this.len + 1])
          return
        }
        if (this.len > MAX_BLOCK) {
          this.restart()
          return
        }
        this.nbits = 8
        return
      }
      case State.Crc1:
        this.crc0 = r
        this.state = State.Crc2
        this.nbits = 8
        return
      case State.Crc2:
        this.emit(this.crc0, r)
        return
      case State.End:
        this.restart()
        this.nbits = 8
        return
    }
  }

  private emit(crc0: number, crc1: number): void {
    const levelDb = 10 * Math.log10(this.lvlSum / Math.max(1, this.bitCount))
    this.onBlock?.({
      txt: this.txt.slice(0, this.len),
      crc0,
      crc1,
      levelDb,
      at: this.startAt,
    })
    this.state = State.End
    this.nbits = 8
  }
}

function oddParity(b: number): boolean {
  b ^= b >> 4
  b ^= b >> 2
  b ^= b >> 1
  return (b & 1) === 1
}

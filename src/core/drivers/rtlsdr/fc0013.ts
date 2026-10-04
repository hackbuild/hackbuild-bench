/**
 * Fitipower FC0013 tuner, ported from tuner_fc0013.c and the fc0013 wrappers
 * in librtlsdr. A zero if tuner sharing the FC0012 divider math, with its own
 * band table, vhf tracking filter and a finer lna gain table.
 *
 * Register access order matches the C exactly, reads included, so the port
 * can be diffed against it transfer by transfer.
 */

import { FC_BANDWIDTH, fcPll, fcRanges } from './fc0012'
import type { FcBand } from './fc0012'
import type { Tuner, TunerHost } from './tuner'

/** Tuner address on the gated i2c bus, the same one the FC0012 uses. */
export const FC0013_ADDR = 0xc6

/** Register 0 reads back 0xa3 at that address. */
export const FC0013_ID = 0xa3

/** Registers 1 to 0x15, with the 28.8 MHz crystal bit of 0x07 and the dual master bit of 0x0c set. */
const FC0013_INIT = [
  0x09, 0x16, 0x00, 0x00, 0x17, 0x02, 0x2a, 0xff, 0x6e, 0xb8, 0x82, 0xfe, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x50, 0x01,
]

const FC0013_BANDS: FcBand[] = [
  [37084000, 96, 0x82, 0x00],
  [55625000, 64, 0x02, 0x02],
  [74167000, 48, 0x42, 0x00],
  [111250000, 32, 0x82, 0x02],
  [148334000, 24, 0x22, 0x00],
  [222500000, 16, 0x42, 0x02],
  [296667000, 12, 0x12, 0x00],
  [445000000, 8, 0x22, 0x02],
  [593334000, 6, 0x0a, 0x00],
  [950000000, 4, 0x12, 0x02],
  [Infinity, 2, 0x0a, 0x02],
]

/** Upper edge in Hz, inclusive below 300 MHz, and the vhf track bits of reg 0x1d. */
const VHF_TRACK: Array<[number, number]> = [
  [177500000, 0x1c],
  [184500000, 0x18],
  [191500000, 0x14],
  [198500000, 0x10],
  [205500000, 0x0c],
  [219500000, 0x08],
]

/**
 * Lna gain in tenths of a dB and the reg 0x14 code for it, in the C order. A
 * request takes the first entry at or above it, or the last entry.
 */
const LNA_GAINS: Array<[number, number]> = [
  [-99, 0x02],
  [-73, 0x03],
  [-65, 0x05],
  [-63, 0x04],
  [-63, 0x00],
  [-60, 0x07],
  [-58, 0x01],
  [-54, 0x06],
  [58, 0x0f],
  [61, 0x0e],
  [63, 0x0d],
  [65, 0x0c],
  [67, 0x0b],
  [68, 0x0a],
  [70, 0x09],
  [71, 0x08],
  [179, 0x17],
  [181, 0x16],
  [182, 0x15],
  [184, 0x14],
  [186, 0x13],
  [188, 0x12],
  [191, 0x11],
  [197, 0x10],
]

/** Gains librtlsdr offers for the FC0013, tenths of a dB. */
const FC0013_GAINS = [
  -99, -73, -65, -63, -60, -58, -54, 58, 61, 63, 65, 67, 68, 70, 71, 179, 181, 182, 184, 186, 188, 191, 197,
]

export class FC0013 implements Tuner {
  readonly name = 'fc0013'
  readonly lowIf = false
  readonly agc = true
  readonly gains = FC0013_GAINS
  /** librtlsdr checks no lock bit, so this is true whenever the divider math found a combination. */
  pllLock = false
  private host: TunerHost
  private xtal: number

  constructor(host: TunerHost) {
    this.host = host
    this.xtal = host.xtal
  }

  get ranges(): Array<[number, number]> {
    return fcRanges(this.xtal, FC0013_BANDS)
  }

  setXtal(hz: number): void {
    this.xtal = hz
  }

  private wr(reg: number, val: number): Promise<void> {
    return this.host.com.i2cWrite(FC0013_ADDR, reg, val)
  }

  private rd(reg: number): Promise<number> {
    return this.host.com.i2cRead(FC0013_ADDR, reg)
  }

  async init(): Promise<void> {
    for (let i = 0; i < FC0013_INIT.length; i++) await this.wr(i + 1, FC0013_INIT[i])
  }

  private async setVhfTrack(freq: number): Promise<void> {
    const tmp = (await this.rd(0x1d)) & 0xe3
    let bits = 0x1c
    if (freq < 300000000) bits = VHF_TRACK.find((t) => freq <= t[0])?.[1] ?? 0x04
    await this.wr(0x1d, tmp | bits)
  }

  /**
   * The vhf track and filter registers are written before the divider math,
   * so a frequency with no divider combination still changes them.
   */
  async setFrequency(hz: number): Promise<number | null> {
    const freq = hz >>> 0
    await this.setVhfTrack(freq)

    const vhf = freq < 300000000
    const r7 = await this.rd(0x07)
    await this.wr(0x07, vhf ? r7 | 0x10 : r7 & 0xef)
    const r14 = await this.rd(0x14)
    await this.wr(0x14, vhf ? r14 & 0x1f : (r14 & 0x1f) | 0x40)

    const pll = fcPll(freq, this.xtal, FC0013_BANDS, FC_BANDWIDTH)
    if (!pll) {
      this.pllLock = false
      return null
    }
    const reg = pll.reg
    for (let i = 1; i <= 6; i++) await this.wr(i, reg[i])

    const r11 = await this.rd(0x11)
    await this.wr(0x11, pll.multi === 64 ? r11 | 0x04 : r11 & 0xfb)

    await this.wr(0x0e, 0x80)
    await this.wr(0x0e, 0x00)
    await this.wr(0x0e, 0x00)
    // reg 0x0e reads back the vco control voltage. Near either rail the
    // other vco range is selected and calibration runs again.
    const v = (await this.rd(0x0e)) & 0x3f
    if (pll.vcoSelect ? v > 0x3c : v < 0x02) {
      reg[6] = pll.vcoSelect ? reg[6] & ~0x08 : reg[6] | 0x08
      await this.wr(0x06, reg[6])
      await this.wr(0x0e, 0x80)
      await this.wr(0x0e, 0x00)
    }
    this.pllLock = true
    return freq
  }

  async setBandwidth(_bw: number): Promise<number | null> {
    return null
  }

  /** Bit 3 of reg 0x0d forces the lna gain. Either way the if gain is pinned at 0x0a. */
  private async setGainMode(manual: boolean): Promise<void> {
    const tmp = await this.rd(0x0d)
    await this.wr(0x0d, manual ? tmp | 0x08 : tmp & ~0x08)
    await this.wr(0x13, 0x0a)
  }

  async setGain(tenths: number | null): Promise<void> {
    if (tenths === null) {
      await this.setGainMode(false)
      return
    }
    await this.setGainMode(true)
    const gain = tenths | 0
    const tmp = (await this.rd(0x14)) & 0xe0
    const hit = LNA_GAINS.find((g) => g[0] >= gain) ?? LNA_GAINS[LNA_GAINS.length - 1]
    await this.wr(0x14, tmp | hit[1])
  }

  async shutdown(): Promise<void> {}
}

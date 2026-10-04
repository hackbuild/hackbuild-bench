/**
 * Fitipower FC0012 tuner, ported from tuner_fc0012.c and the fc0012 wrappers
 * in librtlsdr. A zero if tuner with one lna gain register.
 *
 * Register access order matches the C exactly, reads included, so the port
 * can be diffed against it transfer by transfer.
 */

import type { Tuner, TunerHost } from './tuner'

/** Tuner address on the gated i2c bus. The FC0013 answers here too. */
export const FC0012_ADDR = 0xc6

/** Register 0 reads back 0xa1 at that address. */
export const FC0012_ID = 0xa1

/** Registers 1 to 0x15, with the 28.8 MHz crystal bit of 0x07 and the dual master bit of 0x0c set. */
const FC0012_INIT = [
  0x05, 0x10, 0x00, 0x00, 0x0f, 0x00, 0x20, 0xff, 0x6e, 0xb8, 0x82, 0xfe, 0x02, 0x00, 0x00, 0x00,
  0x00, 0x1f, 0x00, 0x00, 0x04,
]

/** Exclusive upper edge in Hz, vco multiplier, then the base values of regs 5 and 6. */
export type FcBand = [number, number, number, number]

const FC0012_BANDS: FcBand[] = [
  [37084000, 96, 0x82, 0x00],
  [55625000, 64, 0x82, 0x02],
  [74167000, 48, 0x42, 0x00],
  [111250000, 32, 0x42, 0x02],
  [148334000, 24, 0x22, 0x00],
  [222500000, 16, 0x22, 0x02],
  [296667000, 12, 0x12, 0x00],
  [445000000, 8, 0x12, 0x02],
  [593334000, 6, 0x0a, 0x00],
  [Infinity, 4, 0x0a, 0x02],
]

/** librtlsdr hands both FC tuners a fixed 6 MHz bandwidth. */
export const FC_BANDWIDTH = 6000000

/** Gains librtlsdr offers for the FC0012, tenths of a dB. */
const FC0012_GAINS = [-99, -40, 71, 179, 192]

const U32 = 0x100000000

/** Register values for one tune, shared by the FC0012 and FC0013. */
export interface FcPll {
  /** Index 1 to 6 are regs 1 to 6. Index 0 is unused, as in the C. */
  reg: number[]
  multi: number
  vcoSelect: boolean
}

/**
 * The divider math of fc001x_set_params, in the C integer widths. freq times
 * multi is a 32 bit product that wraps before it widens to 64 bits, so the
 * FC0012 above 1073741823 Hz computes a vco from the wrapped value.
 */
export function fcPll(freq: number, xtal: number, bands: FcBand[], bandwidth: number): FcPll | null {
  const x = BigInt((xtal >>> 0) >>> 1)
  const band = bands.find((b) => freq < b[0]) ?? bands[bands.length - 1]
  const [, multi, reg5, reg6] = band
  const reg = [0, 0, 0, 0, 0, reg5, reg6]

  const fVco = BigInt.asUintN(32, BigInt(freq) * BigInt(multi))
  let vcoSelect = false
  if (fVco >= 3060000000n) {
    reg[6] |= 0x08
    vcoSelect = true
  }

  let xdiv = BigInt.asUintN(16, fVco / x)
  if (BigInt.asUintN(64, fVco - BigInt.asUintN(32, xdiv * x)) >= x / 2n) xdiv = BigInt.asUintN(16, xdiv + 1n)

  const xd = Number(xdiv)
  let pm = Math.trunc(xd / 8) & 0xff
  let am = (xd - 8 * pm) & 0xff
  if (am < 2) {
    am = (am + 8) & 0xff
    pm = (pm - 1) & 0xff
  }
  if (pm > 31) {
    reg[1] = (am + 8 * (pm - 31)) & 0xff
    reg[2] = 31
  } else {
    reg[1] = am
    reg[2] = pm
  }
  if (reg[1] > 15 || reg[2] < 0x0b) return null

  reg[6] |= 0x20

  let xin = BigInt.asUintN(16, (fVco - (fVco / x) * x) / 1000n)
  xin = BigInt.asUintN(16, (xin << 15n) / (x / 1000n))
  if (xin >= 16384n) xin = BigInt.asUintN(16, xin + 32768n)
  const xi = Number(xin)
  reg[3] = xi >> 8
  reg[4] = xi & 0xff

  reg[6] &= 0x3f
  if (bandwidth === 6000000) reg[6] |= 0x80
  else if (bandwidth === 7000000) reg[6] |= 0x40

  reg[5] |= 0x07
  return { reg, multi, vcoSelect }
}

/**
 * Frequencies fcPll accepts without the 32 bit vco product wrapping, as
 * inclusive pairs. The divider takes xdiv from 90 to 263, which with
 * x = xtal / 2 and h = x / 2, both truncated, is a vco in [89x + h, 263x + h).
 */
export function fcRanges(xtal: number, bands: FcBand[]): Array<[number, number]> {
  const x = Math.floor((xtal >>> 0) / 2)
  const h = Math.floor(x / 2)
  const vcoLo = 89 * x + h
  const vcoHi = 263 * x + h
  const out: Array<[number, number]> = []
  let lo = 0
  for (const [edge, multi] of bands) {
    const top = Math.min(edge, U32) - 1
    const a = Math.max(lo, Math.ceil(vcoLo / multi))
    const b = Math.min(top, Math.ceil(vcoHi / multi) - 1, Math.floor((U32 - 1) / multi))
    if (a <= b) {
      const last = out[out.length - 1]
      if (last && last[1] + 1 === a) last[1] = b
      else out.push([a, b])
    }
    lo = top + 1
  }
  return out
}

export class FC0012 implements Tuner {
  readonly name = 'fc0012'
  readonly lowIf = false
  readonly agc = false
  readonly gains = FC0012_GAINS
  /** librtlsdr checks no lock bit, so this is true whenever the divider math found a combination. */
  pllLock = false
  private host: TunerHost
  private xtal: number

  constructor(host: TunerHost) {
    this.host = host
    this.xtal = host.xtal
  }

  get ranges(): Array<[number, number]> {
    return fcRanges(this.xtal, FC0012_BANDS)
  }

  setXtal(hz: number): void {
    this.xtal = hz
  }

  private wr(reg: number, val: number): Promise<void> {
    return this.host.com.i2cWrite(FC0012_ADDR, reg, val)
  }

  private rd(reg: number): Promise<number> {
    return this.host.com.i2cRead(FC0012_ADDR, reg)
  }

  /** librtlsdr makes gpio 6 an output when it detects this chip, ahead of init. */
  async init(): Promise<void> {
    await this.host.setGpioOutput(6)
    for (let i = 0; i < FC0012_INIT.length; i++) await this.wr(i + 1, FC0012_INIT[i])
  }

  /** Gpio 6 switches the board between its vhf and uhf filters. */
  async setFrequency(hz: number): Promise<number | null> {
    const freq = hz >>> 0
    await this.host.setGpioBit(6, freq > 300000000)
    const pll = fcPll(freq, this.xtal, FC0012_BANDS, FC_BANDWIDTH)
    if (!pll) {
      this.pllLock = false
      return null
    }
    const reg = pll.reg
    for (let i = 1; i <= 6; i++) await this.wr(i, reg[i])

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

  /** The FC0012 has no agc switch, so null leaves the lna gain as it was. */
  async setGain(tenths: number | null): Promise<void> {
    if (tenths === null) return
    const gain = tenths | 0
    let tmp = (await this.rd(0x13)) & 0xe0
    if (gain < -40) tmp |= 0x02
    else if (gain < 71) tmp |= 0x00
    else if (gain < 179) tmp |= 0x08
    else if (gain < 192) tmp |= 0x17
    else tmp |= 0x10
    await this.wr(0x13, tmp)
  }

  async shutdown(): Promise<void> {}
}

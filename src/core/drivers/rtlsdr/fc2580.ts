/**
 * FCI FC2580 tuner, a zero if part, ported from tuner_fc2580.c in osmocom
 * librtlsdr. Register access order matches the C write for write and read for
 * read, so a capture from either can be diffed against the other.
 *
 * The caller opens the i2c gate before any method here and closes it after.
 */

import { BLOCK } from './rtlcom'
import type { Tuner, TunerHost } from './tuner'

/** 8 bit bus address, as librtlsdr passes it. */
export const FC2580_ADDR = 0xac

/** Register 0x01 reads back 0x56 once bit 7 is masked off. */
export const FC2580_CHECK_ADDR = 0x01
export const FC2580_CHECK_VAL = 0x56

/**
 * librtlsdr hardcodes the 16.384 MHz crystal of the Logilink VG0002A and never
 * asks the host for its clock, so host.xtal and setXtal have no effect here.
 * A dongle with a different crystal tunes off frequency in the C as well.
 */
const CRYSTAL_KHZ = Math.floor((16384000 + 500) / 1000)

/** VCO band select threshold, in kHz. */
const BORDER_FREQ = 2600000

const BAND_UHF = 0
const BAND_L = 1
const BAND_VHF = 2

/** AGC mode passed by fc2580_Initialize, voltage control. */
const AGC_EXTERNAL = 2

type Wr = [number, number]

const UHF_COMMON: Wr[] = [
  [0x25, 0xf0],
  [0x27, 0x77],
  [0x28, 0x53],
  [0x29, 0x60],
  [0x30, 0x09],
  [0x50, 0x8c],
  [0x53, 0x50],
]

const UHF_BELOW_538: Wr[] = [
  [0x61, 0x07],
  [0x62, 0x06],
  [0x67, 0x06],
  [0x68, 0x08],
  [0x69, 0x10],
  [0x6a, 0x12],
]

const UHF_BELOW_794: Wr[] = [
  [0x61, 0x03],
  [0x62, 0x03],
  [0x67, 0x03],
  [0x68, 0x05],
  [0x69, 0x0c],
  [0x6a, 0x0e],
]

const UHF_ABOVE: Wr[] = [
  [0x61, 0x07],
  [0x62, 0x06],
  [0x67, 0x07],
  [0x68, 0x09],
  [0x69, 0x10],
  [0x6a, 0x12],
]

const UHF_TAIL: Wr[] = [
  [0x63, 0x15],
  [0x6b, 0x0b],
  [0x6c, 0x0c],
  [0x6d, 0x78],
  [0x6e, 0x32],
  [0x6f, 0x14],
]

const VHF_REGS: Wr[] = [
  [0x27, 0x77],
  [0x28, 0x33],
  [0x29, 0x40],
  [0x30, 0x09],
  [0x50, 0x8c],
  [0x53, 0x50],
  [0x5f, 0x0f],
  [0x61, 0x07],
  [0x62, 0x00],
  [0x63, 0x15],
  [0x67, 0x03],
  [0x68, 0x05],
  [0x69, 0x10],
  [0x6a, 0x12],
  [0x6b, 0x08],
  [0x6c, 0x0a],
  [0x6d, 0x78],
  [0x6e, 0x32],
  [0x6f, 0x54],
]

const L_REGS: Wr[] = [
  [0x2b, 0x70],
  [0x2c, 0x37],
  [0x2d, 0xe7],
  [0x30, 0x09],
  [0x44, 0x20],
  [0x50, 0x8c],
  [0x53, 0x50],
  [0x5f, 0x0f],
  [0x61, 0x0f],
  [0x62, 0x00],
  [0x63, 0x13],
  [0x67, 0x00],
  [0x68, 0x02],
  [0x69, 0x0c],
  [0x6a, 0x0e],
  [0x6b, 0x08],
  [0x6c, 0x0a],
  [0x6d, 0xa0],
  [0x6e, 0x50],
  [0x6f, 0x14],
]

export class FC2580 implements Tuner {
  readonly name = 'fc2580'
  readonly lowIf = false
  readonly agc = true
  /**
   * The C programs any frequency, picking VHF up to 400 MHz, UHF up to 1 GHz
   * and L band above, with an lo of vco / 12, vco / 4 and vco / 2. The C has
   * no vco limits. The published coverage used here is one 1752 to 3696 MHz
   * vco span divided by 12 and by 4. The L band path is left out because it
   * forces the 1.53 MHz tdmb channel filter and has no published coverage.
   */
  readonly ranges: Array<[number, number]> = [
    [146000000, 308000000],
    [438000000, 924000000],
  ]
  readonly gains: number[] = []
  /** The C never reads pll lock, so this stays true. */
  pllLock = true

  private host: TunerHost

  constructor(host: TunerHost) {
    this.host = host
  }

  setXtal(_hz: number): void {}

  /**
   * Failures come back as false so the caller can carry on, since the C ands
   * every result together and still issues the remaining accesses.
   */
  private async write(reg: number, val: number): Promise<boolean> {
    try {
      await this.host.com.writeRegBuf(BLOCK.I2C, FC2580_ADDR, new Uint8Array([reg, val & 0xff]))
      return true
    } catch {
      return false
    }
  }

  private async writeList(list: Wr[]): Promise<boolean> {
    let ok = true
    for (const [reg, val] of list) ok = (await this.write(reg, val)) && ok
    return ok
  }

  /**
   * The pointer write and the read fail separately, and on either failure the
   * C leaves the caller's byte untouched, so prev comes back unchanged.
   */
  private async read(reg: number, prev: number): Promise<[boolean, number]> {
    try {
      await this.host.com.writeRegBuf(BLOCK.I2C, FC2580_ADDR, new Uint8Array([reg]))
    } catch {
      return [false, prev]
    }
    try {
      return [true, await this.host.com.readReg(BLOCK.I2C, FC2580_ADDR, 1)]
    } catch {
      return [false, prev]
    }
  }

  private async setFilter(filterBw: number, xtalKhz: number): Promise<boolean> {
    let ok = true
    if (filterBw === 1) {
      ok = (await this.write(0x36, 0x1c)) && ok
      ok = (await this.write(0x37, Math.floor((4151 * xtalKhz) / 1000000))) && ok
      ok = (await this.write(0x39, 0x00)) && ok
      ok = (await this.write(0x2e, 0x09)) && ok
    }
    if (filterBw === 6) {
      ok = (await this.write(0x36, 0x18)) && ok
      ok = (await this.write(0x37, Math.floor((4400 * xtalKhz) / 1000000))) && ok
      ok = (await this.write(0x39, 0x00)) && ok
      ok = (await this.write(0x2e, 0x09)) && ok
    } else if (filterBw === 7) {
      ok = (await this.write(0x36, 0x18)) && ok
      ok = (await this.write(0x37, Math.floor((3910 * xtalKhz) / 1000000))) && ok
      ok = (await this.write(0x39, 0x80)) && ok
      ok = (await this.write(0x2e, 0x09)) && ok
    } else if (filterBw === 8) {
      ok = (await this.write(0x36, 0x18)) && ok
      ok = (await this.write(0x37, Math.floor((3300 * xtalKhz) / 1000000))) && ok
      ok = (await this.write(0x39, 0x80)) && ok
      ok = (await this.write(0x2e, 0x09)) && ok
    }

    let calMon = 0
    for (let i = 0; i < 5; i++) {
      const [rok, v] = await this.read(0x2f, calMon)
      ok = rok && ok
      calMon = v
      if ((calMon & 0xc0) !== 0xc0) {
        ok = (await this.write(0x2e, 0x01)) && ok
        ok = (await this.write(0x2e, 0x09)) && ok
      } else break
    }

    ok = (await this.write(0x2e, 0x01)) && ok
    return ok
  }

  async init(): Promise<void> {
    const agc: number = AGC_EXTERNAL
    let ok = await this.writeList([
      [0x00, 0x00],
      [0x12, 0x86],
      [0x14, 0x5c],
      [0x16, 0x3c],
      [0x1f, 0xd2],
      [0x09, 0xd7],
      [0x0b, 0xd5],
      [0x0c, 0x32],
      [0x0e, 0x43],
      [0x21, 0x0a],
      [0x22, 0x82],
    ])
    if (agc === 1) {
      ok = (await this.write(0x45, 0x10)) && ok
      ok = (await this.write(0x4c, 0x00)) && ok
    } else if (agc === 2) {
      ok = (await this.write(0x45, 0x20)) && ok
      ok = (await this.write(0x4c, 0x02)) && ok
    }
    ok = (await this.write(0x3f, 0x88)) && ok
    ok = (await this.write(0x02, 0x0e)) && ok
    ok = (await this.write(0x58, 0x14)) && ok
    ok = (await this.setFilter(8, CRYSTAL_KHZ)) && ok
    if (!ok) throw new Error('fc2580 init failed')
  }

  /**
   * The C rounds the request to whole kHz and its fractional pll then hits
   * that kHz exactly, so what comes back is the kHz value unless the 8 bit n
   * register wraps, above about 4.19 GHz.
   */
  async setFrequency(hz: number): Promise<number | null> {
    const freq = hz >>> 0
    const fLo = Math.floor((freq + 500) / 1000) >>> 0
    const xtal = CRYSTAL_KHZ
    const preShift = 4
    let data02 = 0x0e

    const band = fLo > 1000000 ? BAND_L : fLo > 400000 ? BAND_UHF : BAND_VHF
    let ok = true

    const mult = band === BAND_UHF ? 4 : band === BAND_L ? 2 : 12
    const fVco = (fLo * mult) >>> 0
    const rVal = fVco >= 2 * 76 * xtal ? 1 : fVco >= 76 * xtal ? 2 : 4
    const fComp = Math.floor(xtal / rVal)
    const nVal = Math.floor(Math.floor(fVco / 2) / fComp)

    const fDiff = (fVco - 2 * fComp * nVal) >>> 0
    const fDiffShifted = (fDiff << (20 - preShift)) >>> 0
    const div = (2 * fComp) >>> preShift
    let kVal = Math.floor(fDiffShifted / div)
    if (((fDiffShifted - kVal * div) >>> 0) >= fComp >>> preShift) kVal = kVal + 1

    if (fVco >= BORDER_FREQ) data02 = data02 | 0x08
    else data02 = data02 & 0xf7

    if (band === BAND_UHF) {
      data02 = data02 & 0x3f
      ok = (await this.writeList(UHF_COMMON)) && ok
      ok = (await this.write(0x5f, fLo < 538000 ? 0x13 : 0x15)) && ok
      if (fLo < 538000) ok = (await this.writeList(UHF_BELOW_538)) && ok
      else if (fLo < 794000) ok = (await this.writeList(UHF_BELOW_794)) && ok
      else ok = (await this.writeList(UHF_ABOVE)) && ok
      ok = (await this.writeList(UHF_TAIL)) && ok
      ok = (await this.setFilter(8, xtal)) && ok
    } else if (band === BAND_VHF) {
      data02 = (data02 & 0x3f) | 0x80
      ok = (await this.writeList(VHF_REGS)) && ok
      ok = (await this.setFilter(7, xtal)) && ok
    } else {
      data02 = (data02 & 0x3f) | 0x40
      ok = (await this.writeList(L_REGS)) && ok
      ok = (await this.setFilter(1, xtal)) && ok
    }

    if (xtal >= 28000) ok = (await this.write(0x4b, 0x22)) && ok

    ok = (await this.write(0x02, data02)) && ok
    const rBits = rVal === 1 ? 0x00 : rVal === 2 ? 0x10 : 0x20
    ok = (await this.write(0x18, rBits + ((kVal >>> 16) & 0xff))) && ok
    ok = (await this.write(0x1a, (kVal >>> 8) & 0xff)) && ok
    ok = (await this.write(0x1b, kVal & 0xff)) && ok
    ok = (await this.write(0x1c, nVal & 0xff)) && ok

    if (band === BAND_UHF) ok = (await this.write(0x2d, fLo <= 794000 ? 0x9f : 0x8f)) && ok

    if (!ok) return null
    const n = BigInt(nVal & 0xff)
    const k = BigInt(kVal & 0xfffff)
    const num = 2n * 16384000n * ((n << 20n) + k)
    return Number(num / (BigInt(rVal) * BigInt(mult) << 20n))
  }

  /** librtlsdr ignores the requested width and always selects the 1.53 MHz filter. */
  async setBandwidth(_bw: number): Promise<number | null> {
    if (!(await this.setFilter(1, CRYSTAL_KHZ))) throw new Error('fc2580 bandwidth failed')
    return null
  }

  async setGain(_tenths: number | null): Promise<void> {}

  async shutdown(): Promise<void> {}
}

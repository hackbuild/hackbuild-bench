/**
 * R820T tuner, and the R820T2 and R860 that answer the same way. Every Nooelec
 * NESDR Mini, Nano and SMArt carries one of the three.
 *
 * The tuner sits behind the RTL2832U i2c gate, so the caller opens the gate
 * before touching any method here and closes it afterwards.
 */

import { IF_FREQ } from './rtlcom'
import type { RtlCom } from './rtlcom'

/** Tuner address on the gated i2c bus. The R828D answers at 0x74 instead. */
export const R820T_ADDR = 0x34

/** Register 0 reads back 0x69 at that address. */
export const R820T_ID = 0x69

/** Written to registers 5 through 31, index plus 5. */
const R820T_INIT = [
  0x83, 0x32, 0x75, 0xc0, 0x40, 0xd6, 0x6c, 0xf5, 0x63, 0x75, 0x68, 0x6c, 0x83, 0x80, 0x00, 0x0f,
  0x00, 0xc0, 0x30, 0x48, 0xcc, 0x60, 0x00, 0x54, 0xae, 0x4a, 0xc0,
]

/** Lowest MHz for the band, then the values for regs 0x17, 0x1a, 0x1b. */
const MUX_CFGS: Array<[number, number, number, number]> = [
  [0, 0x08, 0x02, 0xdf],
  [50, 0x08, 0x02, 0xbe],
  [55, 0x08, 0x02, 0x8b],
  [60, 0x08, 0x02, 0x7b],
  [65, 0x08, 0x02, 0x69],
  [70, 0x08, 0x02, 0x58],
  [75, 0x00, 0x02, 0x44],
  [90, 0x00, 0x02, 0x34],
  [110, 0x00, 0x02, 0x24],
  [140, 0x00, 0x02, 0x14],
  [180, 0x00, 0x02, 0x13],
  [250, 0x00, 0x02, 0x11],
  [280, 0x00, 0x02, 0x00],
  [310, 0x00, 0x41, 0x00],
  [588, 0x00, 0x40, 0x00],
]

/** Gain added by each lna and mixer step, in tenths of a dB. */
const LNA_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13]
const MIXER_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8]

/** Low pass corners of the if filter, widest first, in Hz. */
const IF_LOW_PASS = [1700000, 1600000, 1550000, 1450000, 1200000, 900000, 700000, 550000, 450000, 350000]

/** What the two if high pass stages add to the passband, in Hz. */
const IF_HIGH_PASS_1 = 350000
const IF_HIGH_PASS_2 = 380000

/** A vco between these two is one the pll can lock. */
const VCO_MIN = 1770000000
const VCO_MAX = VCO_MIN * 2

const BIT_REV = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf]

/** addr, value, mask. */
type MaskWrite = [number, number, number]

export class R820T {
  private com: RtlCom
  private xtal: number
  /** Mirror of registers 5 to 31 so read modify write needs no bus read. */
  private shadow: Uint8Array
  pllLock = false
  /**
   * False when the pll would not lock at the calibration frequency. Some
   * R820T2 units do this at every power up and tune fine afterwards.
   */
  calibrated = false
  private initDone = false

  constructor(com: RtlCom, xtalFreq: number) {
    this.com = com
    this.xtal = xtalFreq
    this.shadow = new Uint8Array(R820T_INIT)
  }

  static async detect(com: RtlCom): Promise<boolean> {
    return (await com.i2cProbe(R820T_ADDR, 0)) === R820T_ID
  }

  setXtal(xtalFreq: number): void {
    this.xtal = xtalFreq
  }

  async wrMask(addr: number, value: number, mask: number): Promise<void> {
    const rc = this.shadow[addr - 5]
    const val = (rc & ~mask) | (value & mask)
    this.shadow[addr - 5] = val
    await this.com.i2cWrite(R820T_ADDR, addr, val)
  }

  async each(list: MaskWrite[]): Promise<void> {
    for (const l of list) await this.wrMask(l[0], l[1], l[2])
  }

  /** The tuner returns reads with each nibble bit reversed. */
  async readRegs(addr: number, len: number): Promise<Uint8Array> {
    const d = await this.com.i2cReadBuf(R820T_ADDR, addr, len)
    for (let i = 0; i < d.length; i++) {
      const b = d[i]
      d[i] = (BIT_REV[b & 0xf] << 4) | BIT_REV[b >> 4]
    }
    return d
  }

  async init(): Promise<void> {
    const cmds: Array<['i2c', number, number, number]> = []
    for (let i = 0; i < R820T_INIT.length; i++) {
      cmds.push(['i2c', R820T_ADDR, i + 5, R820T_INIT[i]])
    }
    this.shadow = new Uint8Array(R820T_INIT)
    await this.com.writeEach(cmds)
    await this.each([
      [0x0c, 0x00, 0x0f],
      [0x13, 49, 0x3f],
      [0x1d, 0x00, 0x38],
    ])
    const cap = await this.calibrate()
    this.calibrated = cap !== null
    // librtlsdr leaves the filter at its power on defaults when calibration
    // cannot lock, and the tuner still works, so this does the same.
    if (cap !== null) {
      await this.each([
        [0x0a, 0x10 | cap, 0x1f],
        [0x0b, 0x6b, 0xef],
        [0x07, 0x00, 0x80],
        [0x06, 0x10, 0x30],
        [0x1e, 0x40, 0x60],
        [0x05, 0x00, 0x80],
        [0x1f, 0x00, 0x80],
        [0x0f, 0x00, 0x80],
        [0x19, 0x60, 0x60],
      ])
    }
    await this.each([
      [0x1d, 0xe5, 0xc7],
      [0x1c, 0x24, 0xf8],
      [0x0d, 0x53, 0xff],
      [0x0e, 0x75, 0xff],
      [0x05, 0x00, 0x60],
      [0x06, 0x00, 0x08],
      [0x11, 0x38, 0x38],
      [0x17, 0x30, 0x30],
      [0x0a, 0x40, 0x60],
      [0x1d, 0x00, 0x38],
      [0x1c, 0x00, 0x04],
      [0x06, 0x00, 0x40],
      [0x1a, 0x30, 0x30],
      [0x1d, 0x18, 0x38],
      [0x1c, 0x24, 0x04],
      [0x1e, 0x0e, 0x1f],
      [0x1a, 0x20, 0x30],
    ])
    this.initDone = true
  }

  /**
   * Fits the if filter to the sample rate and returns the if it centres on,
   * which the demod has to be told. At 2.43 MHz and below the filter narrows
   * and the if drops with it.
   */
  async setBandwidth(bw: number): Promise<number> {
    let reg0a: number
    let reg0b: number
    let ifHz: number
    if (bw > 7000000) {
      reg0a = 0x10
      reg0b = 0x0b
      ifHz = 4570000
    } else if (bw > 6000000) {
      reg0a = 0x10
      reg0b = 0x2a
      ifHz = 4570000
    } else if (bw > IF_LOW_PASS[0] + IF_HIGH_PASS_1 + IF_HIGH_PASS_2) {
      reg0a = 0x10
      reg0b = 0x6b
      ifHz = IF_FREQ
    } else {
      reg0a = 0x00
      reg0b = 0x80
      ifHz = 2300000
      let real = 0
      if (bw > IF_LOW_PASS[0] + IF_HIGH_PASS_1) {
        bw -= IF_HIGH_PASS_2
        ifHz += IF_HIGH_PASS_2
        real += IF_HIGH_PASS_2
      } else {
        reg0b |= 0x20
      }
      if (bw > IF_LOW_PASS[0]) {
        bw -= IF_HIGH_PASS_1
        ifHz += IF_HIGH_PASS_1
        real += IF_HIGH_PASS_1
      } else {
        reg0b |= 0x40
      }
      let i = 0
      while (i < IF_LOW_PASS.length && !(bw > IF_LOW_PASS[i])) i++
      i = Math.max(0, i - 1)
      reg0b |= 15 - i
      real += IF_LOW_PASS[i]
      ifHz -= Math.trunc(real / 2)
    }
    await this.each([
      [0x0a, reg0a, 0x10],
      [0x0b, reg0b, 0xef],
    ])
    return ifHz
  }

  /**
   * Filter calibration at 56 MHz, tried twice when the first pass reads back
   * no usable code. Null when the pll will not lock there.
   */
  async calibrate(): Promise<number | null> {
    let code = 0
    for (let i = 0; i < 2; i++) {
      await this.each([
        [0x0b, 0x6b, 0x60],
        [0x0f, 0x04, 0x04],
        [0x10, 0x00, 0x03],
      ])
      await this.setPll(56000000)
      if (!this.pllLock) return null
      await this.each([
        [0x0b, 0x10, 0x10],
        [0x0b, 0x00, 0x10],
        [0x0f, 0x00, 0x04],
      ])
      const d = await this.readRegs(0x00, 5)
      code = d[4] & 0x0f
      if (code !== 0 && code !== 0x0f) break
    }
    return code === 0x0f ? 0 : code
  }

  /** Returns the frequency actually reached, or null when it is out of range. */
  async setFrequency(freq: number): Promise<number | null> {
    await this.setMux(freq)
    return this.setPll(freq)
  }

  async setMux(freq: number): Promise<void> {
    const mhz = freq / 1e6
    let i = 0
    for (; i < MUX_CFGS.length - 1; i++) if (mhz < MUX_CFGS[i + 1][0]) break
    const c = MUX_CFGS[i]
    await this.each([
      [0x17, c[1], 0x08],
      [0x1a, c[2], 0xc3],
      [0x1b, c[3], 0xff],
      [0x10, 0x00, 0x0b],
      [0x08, 0x00, 0x3f],
      [0x09, 0x00, 0x3f],
    ])
  }

  async setPll(freq: number): Promise<number | null> {
    const ref = Math.floor(this.xtal)
    await this.wrMask(0x1a, 0x00, 0x0c)
    // below about 27.7 MHz no divider reaches the vco range, and the ratio of
    // 128 is the closest one. librtlsdr pairs that ratio with divider code 0,
    // this keeps the code that matches it.
    let mixDiv = 128
    let divNum = 6
    for (let m = 2; m <= 64; m <<= 1) {
      if (freq * m >= VCO_MIN && freq * m < VCO_MAX) {
        mixDiv = m
        divNum = Math.log2(m) - 1
        break
      }
    }
    const d = await this.readRegs(0x00, 5)
    const fine = (d[4] & 0x30) >> 4
    if (fine > 2) divNum--
    else if (fine < 2) divNum++
    // the vco current and the dividers go in only after the fine tune read,
    // since the current changes what that read returns.
    await this.each([
      [0x10, divNum << 5, 0xf0],
      [0x12, 0x80, 0xe0],
    ])
    const vco = Math.round(freq) * mixDiv
    const vcoDiv = Math.floor((ref + 65536 * vco) / (2 * ref))
    const nint = Math.floor(vcoDiv / 65536)
    const sdm = vcoDiv % 65536
    if (nint > 63) {
      this.pllLock = false
      return null
    }
    const ni = Math.floor((nint - 13) / 4)
    const si = (nint - 13) % 4
    await this.each([
      [0x14, ni + (si << 6), 0xff],
      [0x12, sdm === 0 ? 0x08 : 0x00, 0x08],
    ])
    await this.each([
      [0x15, sdm & 0xff, 0xff],
      [0x16, sdm >> 8, 0xff],
    ])
    await this.checkLock(true)
    if (this.pllLock) await this.wrMask(0x1a, 0x08, 0x08)
    return (2 * ref * (nint + sdm / 65536)) / mixDiv
  }

  async checkLock(first: boolean): Promise<void> {
    const d = await this.readRegs(0x00, 3)
    if (d[2] & 0x40) {
      this.pllLock = true
      return
    }
    if (first) {
      await this.wrMask(0x12, 0x60, 0xe0)
      return this.checkLock(false)
    }
    this.pllLock = false
  }

  async setAutoGain(): Promise<void> {
    await this.each([
      [0x05, 0x00, 0x10],
      [0x07, 0x10, 0x10],
      [0x0c, 0x0b, 0x9f],
    ])
  }

  /**
   * Alternates lna and mixer steps until the sum reaches the asked gain, so
   * the result lands on or just above it. The vga holds at 16.3 dB.
   */
  async setManualGain(db: number): Promise<void> {
    const want = Math.round(db * 10)
    let total = 0
    let lna = 0
    let mix = 0
    for (let i = 0; i < 15; i++) {
      if (total >= want) break
      total += LNA_STEPS[++lna]
      if (total >= want) break
      total += MIXER_STEPS[++mix]
    }
    await this.each([
      [0x05, 0x10, 0x10],
      [0x07, 0x00, 0x10],
      [0x0c, 0x08, 0x9f],
      [0x05, lna, 0x0f],
      [0x07, mix, 0x0f],
    ])
  }

  async shutdown(): Promise<void> {
    if (!this.initDone) return
    await this.each([
      [0x06, 0xb1, 0xff],
      [0x05, 0xa0, 0xff],
      [0x07, 0x3a, 0xff],
      [0x08, 0x40, 0xff],
      [0x09, 0xc0, 0xff],
      [0x0a, 0x36, 0xff],
      [0x0c, 0x35, 0xff],
      [0x0f, 0x68, 0xff],
      [0x11, 0x03, 0xff],
      [0x17, 0xf4, 0xff],
      [0x19, 0x0c, 0xff],
    ])
  }
}

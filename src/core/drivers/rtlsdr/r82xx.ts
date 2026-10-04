/**
 * The Rafael R82xx family: the R820T, and the R820T2 and R860 that answer the
 * same way, which every Nooelec NESDR Mini, Nano and SMArt carries, plus the
 * R828D and the two RTL-SDR Blog v4 boards built around this family.
 *
 * The tuner sits behind the RTL2832U i2c gate, so the caller opens the gate
 * before touching any method here and closes it afterwards.
 */

import { IF_FREQ } from './rtlcom'
import type { RtlCom } from './rtlcom'
import type { Tuner, TunerHost } from './tuner'

export const R820T_ADDR = 0x34
export const R828D_ADDR = 0x74

/** Register 0 reads back 0x69 on every chip in the family. */
export const R82XX_ID = 0x69

/** A plain R828D runs from its own 16 MHz crystal. The Blog v4 feeds it the RTL2832U's 28.8. */
export const R828D_XTAL = 16000000

/**
 * Which board, since the Blog v4 and v4 lite need their own input switching
 * and upconversion. Both are recognised by their usb strings, as librtlsdr
 * does.
 */
export type R82xxModel = 'r820t' | 'r828d' | 'blog-v4' | 'blog-v4-lite'

/** Below this the Blog v4 boards upconvert by the same amount and switch to the hf input. */
const UPCONVERT_HZ = 28800000

const BAND_HF = 1
const BAND_VHF = 2
const BAND_UHF = 3

/** librtlsdr's manual gain list for the family, tenths of a dB. */
const R82XX_GAINS = [
  0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280, 297, 328, 338, 364, 372,
  386, 402, 421, 434, 439, 445, 480, 496,
]

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

export class R82xx implements Tuner {
  readonly name: string
  readonly lowIf = true
  readonly agc = true
  readonly ranges: Array<[number, number]>
  readonly gains = R82XX_GAINS
  private host: TunerHost
  private com: RtlCom
  private addr: number
  private model: R82xxModel
  private xtal: number
  /** The fine tune code the vco is centred on, 1 on the R828D and the v4 lite. */
  private vcoPowerRef: number
  /** Where the tuner parks the signal. Moves with the bandwidth. */
  private ifHz = IF_FREQ
  /** Last input selection, so a retune inside one band writes nothing. */
  private input = 0
  /** Mirror of registers 5 to 31 so read modify write needs no bus read. */
  private shadow: Uint8Array
  pllLock = false
  /**
   * False when the pll would not lock at the calibration frequency. Some
   * R820T2 units do this at every power up and tune fine afterwards.
   */
  calibrated = false
  private initDone = false

  constructor(host: TunerHost, model: R82xxModel) {
    this.host = host
    this.com = host.com
    this.model = model
    this.xtal = host.xtal
    const r828d = model === 'r828d' || model === 'blog-v4'
    this.addr = r828d ? R828D_ADDR : R820T_ADDR
    this.vcoPowerRef = r828d || model === 'blog-v4-lite' ? 1 : 2
    this.name = {
      r820t: 'r820t/r820t2',
      r828d: 'r828d',
      'blog-v4': 'r828d, rtl-sdr blog v4',
      'blog-v4-lite': 'r820t, rtl-sdr blog v4 lite',
    }[model]
    this.ranges = model === 'blog-v4' || model === 'blog-v4-lite' ? [[500000, 1766e6]] : [[24e6, 1766e6]]
    this.shadow = new Uint8Array(R820T_INIT)
  }

  /** Which family member answers, if any. The gate must be open. */
  static async detect(com: RtlCom): Promise<'r820t' | 'r828d' | null> {
    if ((await com.i2cProbe(R820T_ADDR, 0)) === R82XX_ID) return 'r820t'
    if ((await com.i2cProbe(R828D_ADDR, 0)) === R82XX_ID) return 'r828d'
    return null
  }

  setXtal(xtalFreq: number): void {
    this.xtal = xtalFreq
  }

  async wrMask(addr: number, value: number, mask: number): Promise<void> {
    const rc = this.shadow[addr - 5]
    const val = (rc & ~mask) | (value & mask)
    this.shadow[addr - 5] = val
    await this.com.i2cWrite(this.addr, addr, val)
  }

  async each(list: MaskWrite[]): Promise<void> {
    for (const l of list) await this.wrMask(l[0], l[1], l[2])
  }

  /** The tuner returns reads with each nibble bit reversed. */
  async readRegs(addr: number, len: number): Promise<Uint8Array> {
    const d = await this.com.i2cReadBuf(this.addr, addr, len)
    for (let i = 0; i < d.length; i++) {
      const b = d[i]
      d[i] = (BIT_REV[b & 0xf] << 4) | BIT_REV[b >> 4]
    }
    return d
  }

  async init(): Promise<void> {
    const cmds: Array<['i2c', number, number, number]> = []
    for (let i = 0; i < R820T_INIT.length; i++) {
      cmds.push(['i2c', this.addr, i + 5, R820T_INIT[i]])
    }
    // librtlsdr's init array is declared 30 long and only 27 are filled, so its
    // burst also zeroes 0x20 to 0x22.
    for (let reg = 0x20; reg <= 0x22; reg++) cmds.push(['i2c', this.addr, reg, 0x00])
    this.shadow = new Uint8Array(R820T_INIT)
    this.ifHz = IF_FREQ
    this.input = 0
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
        [0x1e, 0x60, 0x60],
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
  async setBandwidth(bw: number): Promise<number | null> {
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
    this.ifHz = ifHz
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

  /** Returns the rf frequency actually reached, or null when the pll has no setting for it. */
  async setFrequency(rf: number): Promise<number | null> {
    const blog = this.model === 'blog-v4' || this.model === 'blog-v4-lite'
    const upconverted = blog && rf < UPCONVERT_HZ ? rf + UPCONVERT_HZ : rf
    const lo = upconverted + this.ifHz
    await this.setMux(lo)
    const actual = await this.setPll(lo)
    if (actual === null) return null
    const reached = actual - this.ifHz - (upconverted - rf)
    if (!this.pllLock) return reached
    if (this.model === 'blog-v4') await this.switchV4(rf)
    else if (this.model === 'blog-v4-lite') await this.switchV4Lite(rf)
    else if (this.model === 'r828d') {
      // the cable1 and air inputs cross over at 345 MHz, where their noise floors meet.
      const airCable1 = rf > 345e6 ? 0x00 : 0x60
      if (airCable1 !== this.input) {
        this.input = airCable1
        await this.wrMask(0x05, airCable1, 0x60)
      }
    }
    return reached
  }

  /** Newer v4 batches switch the upconverter on gpio 5 as well as through the tuner inputs. */
  private async setUpconverterGpio(on: boolean): Promise<void> {
    await this.host.setGpioOutput(5)
    await this.host.setGpioBit(5, on)
  }

  /** The tracking filter only adds loss on the upconverted hf path. */
  private async bypassTrackingFilter(): Promise<void> {
    await this.wrMask(0x1a, 0x40, 0xc3)
    await this.wrMask(0x1b, 0x00, 0xff)
  }

  private async switchV4(rf: number): Promise<void> {
    // the notches sit over fm broadcast and the vhf tv bands, and come off
    // only when tuned inside them.
    const inNotch = rf <= 2.2e6 || (rf >= 85e6 && rf <= 112e6) || (rf >= 172e6 && rf <= 242e6)
    await this.wrMask(0x17, inNotch ? 0x00 : 0x08, 0x08)
    const band = rf <= UPCONVERT_HZ ? BAND_HF : rf < 250e6 ? BAND_VHF : BAND_UHF
    if (band === BAND_HF) await this.bypassTrackingFilter()
    if (band === this.input) return
    this.input = band
    const cable2 = band === BAND_HF ? 0x08 : 0x00
    await this.wrMask(0x06, cable2, 0x08)
    await this.setUpconverterGpio(!cable2)
    await this.wrMask(0x05, band === BAND_VHF ? 0x40 : 0x00, 0x40)
    await this.wrMask(0x05, band === BAND_UHF ? 0x00 : 0x20, 0x20)
  }

  private async switchV4Lite(rf: number): Promise<void> {
    const band = rf <= UPCONVERT_HZ ? BAND_HF : BAND_UHF
    if (band === BAND_HF) await this.bypassTrackingFilter()
    if (band === this.input) return
    this.input = band
    const cable1 = band === BAND_HF ? 0x40 : 0x00
    await this.setUpconverterGpio(!cable1)
    await this.wrMask(0x05, cable1, 0x40)
    await this.wrMask(0x05, band === BAND_UHF ? 0x00 : 0x20, 0x20)
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
    // the divider is picked from the lo rounded to khz, as librtlsdr picks it.
    const khz = Math.floor((Math.round(freq) + 500) / 1000)
    let mixDiv = 128
    let divNum = 6
    for (let m = 2; m <= 64; m <<= 1) {
      if (khz * m >= VCO_MIN / 1000 && khz * m < VCO_MAX / 1000) {
        mixDiv = m
        divNum = Math.log2(m) - 1
        break
      }
    }
    const d = await this.readRegs(0x00, 5)
    const fine = (d[4] & 0x30) >> 4
    if (fine > this.vcoPowerRef) divNum--
    else if (fine < this.vcoPowerRef) divNum++
    const vco = Math.round(freq) * mixDiv
    const vcoDiv = Math.floor((ref + 65536 * vco) / (2 * ref))
    // nint and the two fields built from it are uint8 in the c.
    const nint = Math.floor(vcoDiv / 65536) & 0xff
    const sdm = vcoDiv % 65536
    // a pll with no setting writes nothing and leaves the last lock state standing.
    if (nint > 128 / this.vcoPowerRef - 1) return null
    // the vco current and the dividers go in only after the fine tune read,
    // since the current changes what that read returns.
    await this.each([
      [0x10, divNum << 5, 0xf0],
      [0x12, 0x80, 0xe0],
    ])
    const ni = Math.trunc((nint - 13) / 4) & 0xff
    const si = (nint - 4 * ni - 13) & 0xff
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

  async setGain(tenths: number | null): Promise<void> {
    if (tenths === null) await this.setAutoGain()
    else await this.setManualGain(tenths)
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
  async setManualGain(tenths: number): Promise<void> {
    const want = tenths
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
    ])
    await this.readRegs(0x00, 4)
    await this.each([
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

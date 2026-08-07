/**
 * R820T / R828D tuner.
 *
 * The tuner sits behind the RTL2832U i2c gate, so the caller opens the gate
 * before touching any method here and closes it afterwards.
 */

import type { RtlCom } from './rtlcom'

/** Tuner address on the gated i2c bus. */
export const R820T_ADDR = 0x34

/** Register 0 reads back 0x69 on both the R820T and the R828D. */
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

const BIT_REV = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf]

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** addr, value, mask. */
type MaskWrite = [number, number, number]

export class R820T {
  private com: RtlCom
  private xtal: number
  /** Mirror of registers 5 to 31 so read modify write needs no bus read. */
  private shadow: Uint8Array
  pllLock = false

  constructor(com: RtlCom, xtalFreq: number) {
    this.com = com
    this.xtal = xtalFreq
    this.shadow = new Uint8Array(R820T_INIT)
  }

  static async detect(com: RtlCom): Promise<boolean> {
    const v = await com.i2cRead(R820T_ADDR, 0)
    return v === R820T_ID
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
    const cap = await this.calibrate(true)
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
      [0x1d, 0xe5, 0xc7],
      [0x1c, 0x24, 0xf8],
      [0x0d, 0x53, 0xff],
      [0x0e, 0x75, 0xff],
      [0x05, 0x00, 0x60],
      [0x06, 0x00, 0x08],
      [0x11, 0x38, 0x08],
      [0x17, 0x30, 0x30],
      [0x0a, 0x40, 0x60],
      [0x1d, 0x00, 0x38],
      [0x1c, 0x00, 0x04],
      [0x06, 0x00, 0x40],
      [0x1a, 0x30, 0x30],
      [0x1d, 0x18, 0x38],
      [0x1c, 0x24, 0x04],
      [0x1e, 0x0d, 0x1f],
      [0x1a, 0x20, 0x30],
    ])
  }

  /** Runs at 56 MHz, and retries once when the first pass returns a cap code. */
  async calibrate(first: boolean): Promise<number> {
    await this.each([
      [0x0b, 0x6b, 0x60],
      [0x0f, 0x04, 0x04],
      [0x10, 0x00, 0x03],
    ])
    await this.setPll(56000000)
    if (!this.pllLock) throw new Error('tuner pll will not lock during filter calibration')
    await this.each([
      [0x0b, 0x10, 0x10],
      [0x0b, 0x00, 0x10],
      [0x0f, 0x00, 0x04],
    ])
    const d = await this.readRegs(0x00, 5)
    let cap = d[4] & 0x0f
    if (cap === 0x0f) cap = 0
    if (cap !== 0 && first) return this.calibrate(false)
    return cap
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
    await this.each([
      [0x10, 0x00, 0x10],
      [0x1a, 0x00, 0x0c],
      [0x12, 0x80, 0xe0],
    ])
    let divNum = Math.min(6, Math.floor(Math.log(1770000000 / freq) / Math.LN2))
    const mixDiv = 1 << (divNum + 1)
    const d = await this.readRegs(0x00, 5)
    const fine = (d[4] & 0x30) >> 4
    if (fine > 2) divNum--
    else if (fine < 2) divNum++
    await this.wrMask(0x10, divNum << 5, 0xe0)
    const vco = freq * mixDiv
    const nint = Math.floor(vco / (2 * ref))
    const fra = vco % (2 * ref)
    if (nint > 63) {
      this.pllLock = false
      return null
    }
    const ni = Math.floor((nint - 13) / 4)
    const si = (nint - 13) % 4
    await this.each([
      [0x14, ni + (si << 6), 0xff],
      [0x12, fra === 0 ? 0x08 : 0x00, 0x08],
    ])
    const sdm = Math.min(65535, Math.floor((32768 * fra) / ref))
    await this.each([
      [0x16, sdm >> 8, 0xff],
      [0x15, sdm & 0xff, 0xff],
    ])
    await this.checkLock(true)
    await this.wrMask(0x1a, 0x08, 0x08)
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

  /** dB maps through two cubics onto a 0 to 30 step split across lna and mixer. */
  async setManualGain(db: number): Promise<void> {
    let step: number
    if (db <= 15) step = Math.round(1.36 + db * (1.1118 + db * (-0.0786 + db * 0.0027)))
    else step = Math.round(1.2068 + db * (0.6875 + db * (-0.01011 + db * 0.0001587)))
    step = clamp(step, 0, 30)
    const lna = Math.floor(step / 2)
    const mix = Math.floor((step - 1) / 2)
    await this.each([
      [0x05, 0x10, 0x10],
      [0x07, 0x00, 0x10],
      [0x0c, 0x08, 0x9f],
      [0x05, lna, 0x0f],
      [0x07, mix, 0x0f],
    ])
  }

  async shutdown(): Promise<void> {
    await this.each([
      [0x06, 0xb1, 0xff],
      [0x05, 0xb3, 0xff],
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

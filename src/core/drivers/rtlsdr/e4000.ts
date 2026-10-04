/**
 * Elonics E4000 zero if tuner, ported from tuner_e4k.c in osmocom librtlsdr.
 *
 * Register access order, reads included, follows the C call for call, so a
 * bus trace from this port can be diffed against one from librtlsdr. Values
 * are uint32 in the C and every path below keeps them inside that range with
 * the same truncation.
 */

import type { Tuner, TunerHost } from './tuner'

/** Address on the gated i2c bus, in the 8 bit form the RTL2832U takes. */
export const E4K_ADDR = 0xc8

const REG = {
  MASTER1: 0x00,
  CLK_INP: 0x05,
  REF_CLK: 0x06,
  SYNTH1: 0x07,
  SYNTH3: 0x09,
  SYNTH4: 0x0a,
  SYNTH5: 0x0b,
  SYNTH7: 0x0d,
  FILT1: 0x10,
  FILT2: 0x11,
  FILT3: 0x12,
  GAIN1: 0x14,
  GAIN2: 0x15,
  GAIN3: 0x16,
  GAIN4: 0x17,
  AGC1: 0x1a,
  AGC4: 0x1d,
  AGC5: 0x1e,
  AGC6: 0x1f,
  AGC7: 0x20,
  AGC11: 0x24,
  DC5: 0x2d,
  DCTIME1: 0x70,
  DCTIME2: 0x71,
  BIAS: 0x78,
  CLKOUT_PWDN: 0x7a,
} as const

const MASTER1_RESET = 0x01
const MASTER1_NORM_STBY = 0x02
const MASTER1_POR_DET = 0x04
const FILT3_DISABLE = 0x20
const AGC1_MOD_MASK = 0x0f
const AGC_MOD_SERIAL = 0x0
const AGC_MOD_IF_SERIAL_LNA_AUTON = 0x9
const AGC7_MIX_GAIN_AUTO = 0x01

const BAND_VHF2 = 0
const BAND_VHF3 = 1
const BAND_UHF = 2
const BAND_L = 3

const PLL_Y = 65536
const EINVAL = 22
const U32 = 4294967296

const WIDTH2MASK = [0, 1, 3, 7, 0xf, 0x1f, 0x3f, 0x7f, 0xff]

/** reg, shift, width. */
type Field = [number, number, number]

const MHZ = 1000000
const KHZ = 1000

const RF_FILT_CENTER_UHF = [360, 380, 405, 425, 450, 475, 505, 540, 575, 615, 670, 720, 760, 840, 890, 970].map(
  (m) => m * MHZ,
)
const RF_FILT_CENTER_L = [
  1300, 1320, 1360, 1410, 1445, 1460, 1490, 1530, 1560, 1590, 1640, 1660, 1680, 1700, 1720, 1750,
].map((m) => m * MHZ)

const IF_FILTER_MIX = 0
const IF_FILTER_CHAN = 1
const IF_FILTER_RC = 2

/** Indexed by IF_FILTER_MIX, IF_FILTER_CHAN, IF_FILTER_RC, in kHz. */
const IF_FILTER_BW = [
  [27000, 27000, 27000, 27000, 27000, 27000, 27000, 27000, 4600, 4200, 3800, 3400, 3300, 2700, 2300, 1900],
  [
    5500, 5300, 5000, 4800, 4600, 4400, 4300, 4100, 3900, 3800, 3700, 3600, 3400, 3300, 3200, 3100, 3000, 2950, 2900,
    2800, 2750, 2700, 2600, 2550, 2500, 2450, 2400, 2300, 2280, 2240, 2200, 2150,
  ],
  [21400, 21000, 17600, 14700, 12400, 10600, 9000, 7700, 6400, 5300, 4400, 3400, 2600, 1800, 1200, 1000],
].map((t) => t.map((k) => k * KHZ))

const IF_FILTER_FIELDS: Field[] = [
  [REG.FILT2, 4, 4],
  [REG.FILT3, 0, 5],
  [REG.FILT2, 0, 4],
]

/** Upper bound in Hz, SYNTH7 value with the 3 phase bit, and divider R. */
const PLL_VARS: Array<[number, number, number]> = [
  [72400 * KHZ, (1 << 3) | 7, 48],
  [81200 * KHZ, (1 << 3) | 6, 40],
  [108300 * KHZ, (1 << 3) | 5, 32],
  [162500 * KHZ, (1 << 3) | 4, 24],
  [216600 * KHZ, (1 << 3) | 3, 16],
  [325000 * KHZ, (1 << 3) | 2, 12],
  [350000 * KHZ, (1 << 3) | 1, 8],
  [432000 * KHZ, (0 << 3) | 3, 8],
  [667000 * KHZ, (0 << 3) | 2, 6],
  [1200000 * KHZ, (0 << 3) | 1, 4],
]

/** Indexed by stage, 1 to 6, in dB. */
const IF_STAGE_GAIN: number[][] = [
  [],
  [-3, 6],
  [0, 3, 6, 9],
  [0, 3, 6, 9],
  [0, 1, 2, 2],
  [3, 6, 9, 12, 15, 15, 15, 15],
  [3, 6, 9, 12, 15, 15, 15, 15],
]

const IF_STAGE_GAIN_REGS: Field[] = [
  [0, 0, 0],
  [REG.GAIN3, 0, 1],
  [REG.GAIN3, 1, 2],
  [REG.GAIN3, 3, 2],
  [REG.GAIN3, 5, 2],
  [REG.GAIN4, 0, 3],
  [REG.GAIN4, 3, 3],
]

/** Lna gain in tenths of a dB, then the GAIN1 code for it. */
const LNA_GAIN: Array<[number, number]> = [
  [-50, 0],
  [-25, 1],
  [0, 4],
  [25, 5],
  [50, 6],
  [75, 7],
  [100, 8],
  [125, 9],
  [150, 10],
  [175, 11],
  [200, 12],
  [250, 13],
  [300, 14],
]

interface PllParams {
  fosc: number
  flo: number
  x: number
  z: number
  r: number
  rIdx: number
}

/** Integer division of non negative integers below 2^53, exact where a / b in doubles may round up. */
function idiv(a: number, b: number): number {
  return (a - (a % b)) / b
}

function closestIdx(arr: number[], freq: number): number {
  let bi = 0
  let best = 0xffffffff
  for (let i = 0; i < arr.length; i++) {
    const delta = Math.abs(freq - arr[i])
    if (delta < best) {
      best = delta
      bi = i
    }
  }
  return bi
}

/** e4k_compute_pll_params, with null where the C returns 0. */
function computePll(fosc: number, intended: number): PllParams | null {
  if (fosc < 16 * MHZ || fosc > 30 * MHZ) return null
  let r = 2
  let rIdx = 0
  for (const p of PLL_VARS) {
    if (intended < p[0]) {
      rIdx = p[1]
      r = p[2]
      break
    }
  }
  const fvcoIntended = intended * r
  const zFull = idiv(fvcoIntended, fosc)
  const remainder = fvcoIntended - fosc * zFull
  const x = idiv(remainder * PLL_Y, fosc) & 0xffff
  // compute_flo takes z as uint8_t, so a z above 255 wraps here while the
  // full value only ever went into the subtraction above.
  const z = zFull & 0xff
  const fvco = fosc * z + idiv(fosc * x, PLL_Y)
  // A zero vco makes compute_flo return -EINVAL through a uint32, which the
  // caller then treats as a valid frequency.
  const flo = fvco === 0 ? U32 - EINVAL : idiv(fvco, r) % U32
  if (flo === 0) return null
  return { fosc, flo, x, z, r, rIdx }
}

export class E4000 implements Tuner {
  readonly name = 'e4000'
  readonly lowIf = false
  readonly agc = true
  /**
   * tuner_e4k.c enforces no limit of its own: E4K_FLO_MIN_MHZ and
   * E4K_FLO_MAX_MHZ are never referenced and the vco check is compiled out,
   * so any uint32 is programmed and only the lock bit says no. These ranges
   * come from the divider table instead. Lock is reported from a vco of
   * about 2.5 to 4.4 GHz, which with R of 48 gives the 52 MHz floor and with
   * R of 2 gives the 2200 MHz ceiling. At 1200 MHz the table drops R from 4
   * to 2, so between about 1100 and 1250 MHz the vco would need to sit
   * above 4.4 GHz or below 2.5 GHz, and the chip does not lock there.
   */
  readonly ranges: Array<[number, number]> = [
    [52000000, 1100000000],
    [1250000000, 2200000000],
  ]
  readonly gains = [-10, 15, 40, 65, 90, 115, 140, 165, 190, 215, 240, 290, 340, 420]
  pllLock = false

  private host: TunerHost
  private fosc: number
  private band = BAND_VHF2
  private flo = 0

  constructor(host: TunerHost) {
    this.host = host
    this.fosc = host.xtal >>> 0
  }

  setXtal(hz: number): void {
    this.fosc = hz >>> 0
  }

  private read(reg: number): Promise<number> {
    return this.host.com.i2cRead(E4K_ADDR, reg)
  }

  private write(reg: number, val: number): Promise<void> {
    return this.host.com.i2cWrite(E4K_ADDR, reg, val & 0xff)
  }

  private async setMask(reg: number, mask: number, val: number): Promise<void> {
    mask &= 0xff
    val &= 0xff
    const tmp = await this.read(reg)
    if ((tmp & mask) === val) return
    await this.write(reg, (tmp & ~mask) | (val & mask))
  }

  /** e4k_field_write reads the register once on its own before the masked write reads it again. */
  private async fieldWrite(field: Field, val: number): Promise<void> {
    const [reg, shift, width] = field
    await this.read(reg)
    await this.setMask(reg, WIDTH2MASK[width] << shift, (val & 0xff) << shift)
  }

  private async ifFilterBwSet(filter: number, bw: number): Promise<void> {
    await this.fieldWrite(IF_FILTER_FIELDS[filter], closestIdx(IF_FILTER_BW[filter], bw))
  }

  private async ifGainSet(stage: number, value: number): Promise<void> {
    const idx = IF_STAGE_GAIN[stage].indexOf(value)
    if (idx < 0) return
    const [reg, shift, width] = IF_STAGE_GAIN_REGS[stage]
    await this.setMask(reg, WIDTH2MASK[width] << shift, idx << shift)
  }

  private async enableManualGain(manual: boolean): Promise<void> {
    if (manual) {
      await this.setMask(REG.AGC1, AGC1_MOD_MASK, AGC_MOD_SERIAL)
      await this.setMask(REG.AGC7, AGC7_MIX_GAIN_AUTO, 0)
    } else {
      await this.setMask(REG.AGC1, AGC1_MOD_MASK, AGC_MOD_IF_SERIAL_LNA_AUTON)
      await this.setMask(REG.AGC7, AGC7_MIX_GAIN_AUTO, 1)
      await this.setMask(REG.AGC11, 0x7, 0)
    }
  }

  async init(): Promise<void> {
    this.fosc = this.host.xtal >>> 0
    // The chip does not ack this first transfer, and librtlsdr ignores the failure.
    await this.host.com.i2cProbe(E4K_ADDR, 0)
    await this.write(REG.MASTER1, MASTER1_RESET | MASTER1_NORM_STBY | MASTER1_POR_DET)
    await this.write(REG.CLK_INP, 0x00)
    await this.write(REG.REF_CLK, 0x00)
    await this.write(REG.CLKOUT_PWDN, 0x96)
    const magic: Array<[number, number]> = [
      [0x7e, 0x01],
      [0x7f, 0xfe],
      [0x82, 0x00],
      [0x86, 0x50],
      [0x87, 0x20],
      [0x88, 0x01],
      [0x9f, 0x7f],
      [0xa0, 0x07],
    ]
    for (const [reg, val] of magic) await this.write(reg, val)
    await this.write(REG.AGC4, 0x10)
    await this.write(REG.AGC5, 0x04)
    await this.write(REG.AGC6, 0x1a)
    await this.setMask(REG.AGC1, AGC1_MOD_MASK, AGC_MOD_SERIAL)
    await this.setMask(REG.AGC7, AGC7_MIX_GAIN_AUTO, 0)
    await this.enableManualGain(false)
    await this.ifGainSet(1, 6)
    await this.ifGainSet(2, 0)
    await this.ifGainSet(3, 0)
    await this.ifGainSet(4, 0)
    await this.ifGainSet(5, 9)
    await this.ifGainSet(6, 9)
    await this.ifFilterBwSet(IF_FILTER_MIX, 1900 * KHZ)
    await this.ifFilterBwSet(IF_FILTER_RC, 1000 * KHZ)
    await this.ifFilterBwSet(IF_FILTER_CHAN, 2150 * KHZ)
    await this.setMask(REG.FILT3, FILT3_DISABLE, 0)
    await this.setMask(REG.DC5, 0x03, 0)
    await this.setMask(REG.DCTIME1, 0x03, 0)
    await this.setMask(REG.DCTIME2, 0x03, 0)
  }

  private async bandSet(band: number): Promise<void> {
    await this.write(REG.BIAS, band === BAND_L ? 0 : 3)
    // librtlsdr clears the band bits first, or 325 to 350 MHz will not tune.
    await this.setMask(REG.SYNTH1, 0x06, 0)
    await this.setMask(REG.SYNTH1, 0x06, band << 1)
    this.band = band
  }

  async setFrequency(hz: number): Promise<number | null> {
    const p = computePll(this.fosc, hz >>> 0)
    if (!p) {
      this.pllLock = false
      return null
    }
    await this.write(REG.SYNTH7, p.rIdx)
    await this.write(REG.SYNTH3, p.z)
    await this.write(REG.SYNTH4, p.x & 0xff)
    await this.write(REG.SYNTH5, p.x >> 8)
    this.fosc = p.fosc
    this.flo = p.flo
    if (this.flo < 140 * MHZ) await this.bandSet(BAND_VHF2)
    else if (this.flo < 350 * MHZ) await this.bandSet(BAND_VHF3)
    else if (this.flo < 1135 * MHZ) await this.bandSet(BAND_UHF)
    else await this.bandSet(BAND_L)
    let rf = 0
    if (this.band === BAND_UHF) rf = closestIdx(RF_FILT_CENTER_UHF, this.flo)
    else if (this.band === BAND_L) rf = closestIdx(RF_FILT_CENTER_L, this.flo)
    await this.setMask(REG.FILT1, 0xf, rf)
    this.pllLock = ((await this.read(REG.SYNTH1)) & 0x01) !== 0
    return this.pllLock ? this.flo : null
  }

  async setBandwidth(bw: number): Promise<number | null> {
    const b = bw >>> 0
    await this.ifFilterBwSet(IF_FILTER_MIX, b)
    await this.ifFilterBwSet(IF_FILTER_RC, b)
    await this.ifFilterBwSet(IF_FILTER_CHAN, b)
    return null
  }

  /** Throws where e4000_set_gain returns -1, after manual mode is already on, as in the C. */
  async setGain(tenths: number | null): Promise<void> {
    if (tenths === null) {
      await this.enableManualGain(false)
      return
    }
    await this.enableManualGain(true)
    const gain = Math.trunc(tenths)
    const mixgain = gain > 340 ? 12 : 4
    const lna = LNA_GAIN.find((l) => l[0] === Math.min(300, gain - mixgain * 10))
    if (!lna) throw new Error(`e4000 has no gain step at ${gain / 10} db`)
    await this.setMask(REG.GAIN1, 0xf, lna[1])
    await this.setMask(REG.GAIN2, 1, mixgain === 12 ? 1 : 0)
  }

  async shutdown(): Promise<void> {
    await this.setMask(REG.MASTER1, MASTER1_NORM_STBY, 0)
  }
}

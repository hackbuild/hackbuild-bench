/**
 * RTL2832U control transfer layer.
 *
 * Every register access is a vendor control transfer with request 0, where
 * value carries the register address and index carries the block, or the block
 * with WRITE_FLAG set for writes.
 */

import type { UsbPort } from '@/core/transport/webusb'

export const BLOCK = {
  DEMOD: 0x000,
  USB: 0x100,
  SYS: 0x200,
  I2C: 0x600,
} as const

export const REG = {
  SYSCTL: 0x2000,
  EPA_CTL: 0x2148,
  EPA_MAXPKT: 0x2158,
  DEMOD_CTL: 0x3000,
  DEMOD_CTL_1: 0x300b,
  GPO: 0x3001,
  GPD: 0x3002,
  GPOE: 0x3003,
} as const

export const WRITE_FLAG = 0x10

/** Reference crystal on every dongle in this family. */
export const XTAL = 28800000

/** The RTL2832U downconverter is parked here and the tuner is offset to match. */
export const IF_FREQ = 3570000

/**
 * Every vendor and product pair librtlsdr opens. Matching on vendor alone
 * would offer every Realtek part on the machine, ethernet adapters and card
 * readers included. Nooelec NESDR sticks enumerate as 0bda:2838.
 */
export const RTL_DEVICES: Array<[number, number, string]> = [
  [0x0bda, 0x2832, 'generic rtl2832u'],
  [0x0bda, 0x2838, 'generic rtl2832u oem'],
  [0x0413, 0x6680, 'digitalnow quad dvb-t'],
  [0x0413, 0x6f0f, 'leadtek winfast dtv mini d'],
  [0x0458, 0x707f, 'genius tvgo dvb-t03'],
  [0x0ccd, 0x00a9, 'terratec cinergy t stick black'],
  [0x0ccd, 0x00b3, 'terratec noxon dab'],
  [0x0ccd, 0x00b4, 'terratec deutschlandradio dab'],
  [0x0ccd, 0x00b5, 'terratec noxon dab radio energy'],
  [0x0ccd, 0x00b7, 'terratec media broadcast dab'],
  [0x0ccd, 0x00b8, 'terratec br dab'],
  [0x0ccd, 0x00b9, 'terratec wdr dab'],
  [0x0ccd, 0x00c0, 'terratec muellerverlag dab'],
  [0x0ccd, 0x00c6, 'terratec fraunhofer dab'],
  [0x0ccd, 0x00d3, 'terratec cinergy t stick rc'],
  [0x0ccd, 0x00d7, 'terratec t stick plus'],
  [0x0ccd, 0x00e0, 'terratec noxon dab rev 2'],
  [0x1554, 0x5020, 'pixelview pv-dt235u'],
  [0x15f4, 0x0131, 'astrometa dvb-t2'],
  [0x15f4, 0x0133, 'hanftek dab fm dvb-t'],
  [0x185b, 0x0620, 'compro videomate u620f'],
  [0x185b, 0x0650, 'compro videomate u650f'],
  [0x185b, 0x0680, 'compro videomate u680f'],
  [0x1b80, 0xd393, 'gigabyte gt-u7300'],
  [0x1b80, 0xd394, 'dikom usb-dvbt hd'],
  [0x1b80, 0xd395, 'peak 102569agpk'],
  [0x1b80, 0xd397, 'kworld kw-ub450-t'],
  [0x1b80, 0xd398, 'zaapa zt-mindvbzp'],
  [0x1b80, 0xd39d, 'sveon stv20'],
  [0x1b80, 0xd3a4, 'twintech ut-40'],
  [0x1b80, 0xd3a8, 'asus u3100mini plus v2'],
  [0x1b80, 0xd3af, 'sveon stv27'],
  [0x1b80, 0xd3b0, 'sveon stv21'],
  [0x1d19, 0x1101, 'dexatek dk dvb-t'],
  [0x1d19, 0x1102, 'dexatek msi digivox mini ii'],
  [0x1d19, 0x1103, 'dexatek dk 5217'],
  [0x1d19, 0x1104, 'msi digivox micro hd'],
  [0x1f4d, 0xa803, 'sweex dvb-t'],
  [0x1f4d, 0xb803, 'gtek t803'],
  [0x1f4d, 0xc803, 'lifeview lv5tdeluxe'],
  [0x1f4d, 0xd286, 'mygica td312'],
  [0x1f4d, 0xd803, 'prolectrix dv107669'],
]

/** One entry in a batched register write. */
export type RtlOp =
  | ['reg', number, number, number, number]
  | ['demod', number, number, number, number]
  | ['i2c', number, number, number]

export class RtlCom {
  private port: UsbPort

  constructor(port: UsbPort) {
    this.port = port
  }

  /** Short reads confuse some hubs, so at least 8 bytes are always requested. */
  async ctrlIn(value: number, index: number, length: number): Promise<Uint8Array> {
    const view = await this.port.controlIn(0, value, index, Math.max(8, length))
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice(0, length)
  }

  async ctrlOut(value: number, index: number, data: BufferSource): Promise<void> {
    await this.port.controlOut(0, value, index, data)
  }

  num2buf(v: number, len: number, big = false): ArrayBuffer {
    const b = new ArrayBuffer(len)
    const dv = new DataView(b)
    if (len === 1) dv.setUint8(0, v & 0xff)
    else if (len === 2) dv.setUint16(0, v & 0xffff, !big)
    else if (len === 4) dv.setUint32(0, v >>> 0, !big)
    else throw new Error(`bad length ${len}`)
    return b
  }

  buf2num(u8: Uint8Array): number {
    if (u8.length === 1) return u8[0]
    if (u8.length === 2) return u8[0] | (u8[1] << 8)
    if (u8.length === 4) return (u8[0] | (u8[1] << 8) | (u8[2] << 16) | (u8[3] << 24)) >>> 0
    throw new Error(`bad register width ${u8.length}`)
  }

  async writeReg(block: number, reg: number, value: number, len: number): Promise<void> {
    await this.ctrlOut(reg, block | WRITE_FLAG, this.num2buf(value, len))
  }

  async readReg(block: number, reg: number, len: number): Promise<number> {
    return this.buf2num(await this.ctrlIn(reg, block, len))
  }

  async writeRegBuf(block: number, reg: number, buf: BufferSource): Promise<void> {
    await this.ctrlOut(reg, block | WRITE_FLAG, buf)
  }

  async readRegBuf(block: number, reg: number, len: number): Promise<Uint8Array> {
    return this.ctrlIn(reg, block, len)
  }

  /** Demod registers live at (addr << 8) | 0x20 inside their page. */
  async readDemod(page: number, addr: number): Promise<number> {
    return this.readReg(page, (addr << 8) | 0x20, 1)
  }

  /**
   * Demod writes are big endian while ordinary register writes are little
   * endian, and the hardware only latches the value once page 0x0a addr 0x01
   * has been read back, so that dummy read is part of the write.
   */
  async writeDemod(page: number, addr: number, value: number, len: number): Promise<number> {
    await this.writeRegBuf(page, (addr << 8) | 0x20, this.num2buf(value, len, true))
    return this.readDemod(0x0a, 0x01)
  }

  /** The tuner i2c bus is gated. Nothing reaches the tuner until this runs. */
  async i2cOpen(): Promise<void> {
    await this.writeDemod(1, 1, 0x18, 1)
  }

  async i2cClose(): Promise<void> {
    await this.writeDemod(1, 1, 0x10, 1)
  }

  async i2cRead(addr: number, reg: number): Promise<number> {
    await this.writeRegBuf(BLOCK.I2C, addr, new Uint8Array([reg]).buffer)
    return this.readReg(BLOCK.I2C, addr, 1)
  }

  /**
   * Reads one register from an address that may have nothing behind it. The
   * RTL2832U answers an i2c nak with a stalled control transfer, which means
   * no chip there, so it comes back as null.
   */
  async i2cProbe(addr: number, reg: number): Promise<number | null> {
    try {
      return await this.i2cRead(addr, reg)
    } catch {
      return null
    }
  }

  async i2cWrite(addr: number, reg: number, value: number): Promise<void> {
    await this.writeRegBuf(BLOCK.I2C, addr, new Uint8Array([reg, value]).buffer)
  }

  /** Writes consecutive registers starting at reg in one transfer. */
  async i2cWriteBuf(addr: number, reg: number, data: Uint8Array): Promise<void> {
    const buf = new Uint8Array(data.length + 1)
    buf[0] = reg
    buf.set(data, 1)
    await this.writeRegBuf(BLOCK.I2C, addr, buf.buffer)
  }

  async i2cReadBuf(addr: number, reg: number, len: number): Promise<Uint8Array> {
    await this.writeRegBuf(BLOCK.I2C, addr, new Uint8Array([reg]).buffer)
    return this.readRegBuf(BLOCK.I2C, addr, len)
  }

  async writeEach(list: RtlOp[]): Promise<void> {
    for (const l of list) {
      if (l[0] === 'reg') await this.writeReg(l[1], l[2], l[3], l[4])
      else if (l[0] === 'demod') await this.writeDemod(l[1], l[2], l[3], l[4])
      else if (l[0] === 'i2c') await this.i2cWrite(l[1], l[2], l[3])
      else throw new Error(`bad op ${l[0]}`)
    }
  }
}

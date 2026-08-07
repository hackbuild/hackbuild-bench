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
 * Vendor ids that ship an RTL2832U front end. No product ids are filtered,
 * since the same silicon appears under dozens of them.
 */
export const RTL_VENDORS = [
  0x0bda, 0x0413, 0x0458, 0x0ccd, 0x1554, 0x15f4, 0x185b, 0x1b80, 0x1d19, 0x1f4d, 0x1209,
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

  async i2cWrite(addr: number, reg: number, value: number): Promise<void> {
    await this.writeRegBuf(BLOCK.I2C, addr, new Uint8Array([reg, value]).buffer)
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

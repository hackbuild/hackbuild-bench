/**
 * Ubertooth One over WebUSB.
 *
 * Command numbers, the 64 byte usb_pkt_rx layout and the SPECAN triple format
 * follow libubertooth ubertooth_control.h and firmware/common/ubertooth_usb.h.
 * Every command is a vendor control transfer to the device recipient, and all
 * capture arrives on bulk endpoint 2 in 64 byte packets.
 *
 * The radio only ever receives here. No exposed mode keys the transmitter.
 */

import type { Capability } from '@/core/capabilities'
import { CAPABILITIES } from '@/core/capabilities'
import type {
  DeviceDriver,
  DeviceHandle,
  DeviceSession,
  DriverContext,
  StartMode,
} from '@/core/drivers/types'
import { UsbPort } from '@/core/transport/webusb'
import type { Artifact, DeviceDescriptor, FftFrame, PacketRecord, TransportKind } from '@/core/types'
import { freqToBleChannel, hex, parseAdvertisement } from './ble'

type Emitted<T extends Artifact> = Omit<T, 'source' | 'seq' | 't' | 'wall'>

const CMD = {
  PING: 0,
  RX_SYMBOLS: 1,
  GET_CHANNEL: 11,
  SET_CHANNEL: 12,
  RESET: 13,
  GET_SERIAL: 14,
  GET_PARTNUM: 15,
  STOP: 21,
  GET_MOD: 22,
  SET_MOD: 23,
  SPECAN: 27,
  GET_REV_NUM: 33,
  GET_BOARD_ID: 35,
  BTLE_SNIFFING: 42,
  SET_ACCESS_ADDRESS: 44,
  BTLE_PROMISC: 50,
  GET_COMPILE_INFO: 55,
} as const

/** usb_pkt_rx packet types. */
const PKT = {
  BR: 0,
  LE: 1,
  MESSAGE: 2,
  KEEP_ALIVE: 3,
  SPECAN: 4,
  LE_PROMISC: 5,
  EGO: 6,
} as const

/** MOD_BT_BASIC_RATE, MOD_BT_LOW_ENERGY, MOD_80211_FHSS, MOD_NONE. */
const MOD = { BASIC_RATE: 0, LOW_ENERGY: 1 } as const

const EP_IN = 2
const PKT_LEN = 64

const SPEC_LOW = 2402
const SPEC_HIGH = 2480
const SPEC_BINS = SPEC_HIGH - SPEC_LOW + 1

const USB_FILTERS: USBDeviceFilter[] = [{ vendorId: 0x1d50, productId: 0x6002 }]

const BOARD_NAMES: Record<number, string> = {
  0: 'ubertooth zero',
  1: 'ubertooth one',
  2: 'toorcon 13 badge',
}

export const ubertoothDescriptor: DeviceDescriptor = {
  kind: 'ubertooth',
  name: 'Ubertooth One',
  blurb: 'a bluetooth workbench',
  icon: 'bluetooth-b',
  transports: ['webusb'],
  capabilities: [CAPABILITIES.OBSERVE_SPECTRUM, CAPABILITIES.CAPTURE_PACKET],
  params: [
    { key: 'channel', label: 'channel', unit: 'MHz', min: 2402, max: 2480, step: 1, default: 2402 },
    { key: 'advChannel', label: 'adv channel', min: 37, max: 39, step: 1, default: 37 },
    { key: 'rssiOffset', label: 'rssi offset', unit: 'dB', min: -100, max: 0, step: 1, default: -54 },
  ],
  usbFilters: USB_FILTERS,
  limits: {
    [CAPABILITIES.OBSERVE_SPECTRUM]:
      'the sweep covers 2402 to 2480 MHz, one bin per MHz. it cannot see any other band.',
    [CAPABILITIES.CAPTURE_PACKET]:
      'ble advertisements decode in full. classic br/edr is a lap survey off raw symbols, so addresses are partial and some rows are noise.',
  },
}

export const ubertoothStartModes: StartMode[] = [
  { id: 'spectrum', label: '2.4 GHz sweep', requires: CAPABILITIES.OBSERVE_SPECTRUM },
  { id: 'ble', label: 'ble advertisements', requires: CAPABILITIES.CAPTURE_PACKET },
  { id: 'classic', label: 'classic lap survey', requires: CAPABILITIES.CAPTURE_PACKET },
]

/** Advertising channel index to centre frequency in MHz. */
function advFreq(index: number): number {
  if (index === 38) return 2426
  if (index === 39) return 2480
  return 2402
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface UsbPacket {
  type: number
  status: number
  channel: number
  clknHigh: number
  clk100ns: number
  rssiMax: number
  rssiMin: number
  rssiAvg: number
  rssiCount: number
  data: Uint8Array
}

/** 64 byte usb_pkt_rx: 14 byte header then a 50 byte payload. */
function parseUsbPacket(b: Uint8Array): UsbPacket {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  return {
    type: b[0],
    status: b[1],
    channel: b[2],
    clknHigh: b[3],
    clk100ns: dv.getUint32(4, true),
    rssiMax: dv.getInt8(8),
    rssiMin: dv.getInt8(9),
    rssiAvg: dv.getInt8(10),
    rssiCount: b[11],
    data: b.subarray(14, 64),
  }
}

/**
 * Slide over demodulated symbols looking for a sync word preamble, then take
 * the next 24 bits as a candidate lower address part. This is a heuristic and
 * produces false hits, which is why the survey counts repeats before it
 * believes a LAP.
 */
function extractLaps(sym: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i + 3 < sym.length; i++) {
    if (sym[i] !== 0xaa && sym[i] !== 0x55) continue
    const lap = ((sym[i + 1] << 16) | (sym[i + 2] << 8) | sym[i + 3]) & 0xffffff
    if (lap === 0 || lap === 0xffffff) continue
    if (!out.includes(lap)) out.push(lap)
  }
  return out
}

class UbertoothSession implements DeviceSession {
  private usb: UsbPort
  private ctx: DriverContext
  private params: Record<string, number> = {
    channel: 2402,
    advChannel: 37,
    rssiOffset: -54,
  }
  private info: Record<string, string> = {}
  private abort: AbortController | null = null
  private mode = ''
  private bins = new Float32Array(SPEC_BINS).fill(-120)
  private lastSweepFreq = 0
  private lastSweepAt = 0
  private laps = new Map<number, { count: number; rssi: number; clkn: number }>()

  constructor(usb: UsbPort, ctx: DriverContext) {
    this.usb = usb
    this.ctx = ctx
  }

  // -------------------------------------------------------------------------
  // control transfers
  // -------------------------------------------------------------------------

  private async command(request: number, value = 0, index = 0, data?: BufferSource): Promise<void> {
    await this.usb.controlOut(request, value, index, data)
  }

  private async read(request: number, length: number, value = 0, index = 0): Promise<Uint8Array> {
    const dv = await this.usb.controlIn(request, value, index, length)
    return new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
  }

  private async setChannel(mhz: number): Promise<void> {
    await this.command(CMD.SET_CHANNEL, mhz & 0xffff)
  }

  private async setMod(m: number): Promise<void> {
    await this.command(CMD.SET_MOD, m & 0xff)
  }

  /** low MHz in value, high MHz in index. */
  private async specan(low: number, high: number): Promise<void> {
    await this.command(CMD.SPECAN, low & 0xffff, high & 0xffff)
  }

  async init(): Promise<void> {
    try {
      await this.command(CMD.STOP)
    } catch {
      // a fresh device is already stopped and answers with a stall.
    }

    try {
      const d = await this.read(CMD.GET_REV_NUM, 258)
      const ver = d[0] | (d[1] << 8)
      let text = String(ver)
      if (d.length > 2) {
        const n = Math.min(d[2], d.length - 3)
        let s = ''
        for (let i = 0; i < n; i++) s += String.fromCharCode(d[3 + i])
        if (s) text = s
      }
      this.info.firmware = text
    } catch {
      this.info.firmware = 'unknown'
    }

    try {
      const d = await this.read(CMD.GET_PARTNUM, 5)
      if (d[0] === 0) {
        const part = ((d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24)) >>> 0).toString(16)
        this.info.part = `0x${part}`
      }
    } catch {
      // part number is informational, an old firmware may not answer.
    }

    try {
      const d = await this.read(CMD.GET_SERIAL, 17)
      if (d[0] === 0) this.info.serial = hex(d.subarray(1, 17))
    } catch {
      // same, informational only.
    }

    try {
      const d = await this.read(CMD.GET_BOARD_ID, 1)
      this.info.board = BOARD_NAMES[d[0]] ?? `board ${d[0]}`
    } catch {
      // same, informational only.
    }

    try {
      const d = await this.read(CMD.GET_COMPILE_INFO, 256)
      const n = Math.min(d[0], d.length - 1)
      let s = ''
      for (let i = 0; i < n; i++) s += String.fromCharCode(d[1 + i])
      if (s) this.info.build = s
    } catch {
      // same, informational only.
    }

    this.ctx.setInfo(this.info)
  }

  // -------------------------------------------------------------------------
  // session contract
  // -------------------------------------------------------------------------

  getCapabilities(): Capability[] {
    return [CAPABILITIES.OBSERVE_SPECTRUM, CAPABILITIES.CAPTURE_PACKET]
  }

  getInfo(): Record<string, string> {
    return { ...this.info }
  }

  async configure(params: Record<string, number>): Promise<void> {
    const previous = this.params.channel
    this.params = { ...this.params, ...params }
    if (this.mode === 'classic' && this.params.channel !== previous) {
      await this.setChannel(Math.round(this.params.channel))
    }
  }

  async start(mode: string): Promise<void> {
    await this.stop()

    const abort = new AbortController()
    this.abort = abort
    this.mode = mode
    this.laps.clear()
    this.bins.fill(-120)
    this.lastSweepFreq = 0

    // the firmware refuses a new mode until the previous one has torn down.
    try {
      await this.command(CMD.STOP)
    } catch {
      // an idle device stalls the stop, which is the state we wanted anyway.
    }
    await sleep(40)

    switch (mode) {
      case 'spectrum':
        await this.specan(SPEC_LOW, SPEC_HIGH)
        break
      case 'ble':
        await this.setChannel(advFreq(Math.round(this.params.advChannel)))
        await this.setMod(MOD.LOW_ENERGY)
        // BTLE_SNIFFING with follow set reports advertisements on the tuned
        // advertising channel. BTLE_PROMISC hunts connections already running.
        await this.command(CMD.BTLE_SNIFFING, 1)
        break
      case 'classic':
        await this.setChannel(Math.round(this.params.channel))
        await this.setMod(MOD.BASIC_RATE)
        await this.command(CMD.RX_SYMBOLS)
        break
      default:
        this.abort = null
        this.mode = ''
        throw new Error(`ubertooth has no mode called ${mode}`)
    }

    void this.pump(abort.signal)
  }

  async stop(): Promise<void> {
    if (!this.abort) return
    this.abort.abort()
    this.abort = null
    this.mode = ''
    try {
      await this.command(CMD.STOP)
    } catch {
      // the device may already be unplugged, the loop exits either way.
    }
  }

  /** Stopping the capture is the whole of it. No exposed mode keys the radio. */
  async resetToSafeState(): Promise<void> {
    await this.stop()
  }

  async close(): Promise<void> {
    await this.resetToSafeState()
    await this.usb.release()
  }

  async health(): Promise<boolean> {
    if (!this.usb.isOpen) return false
    if (this.abort) return true
    try {
      await this.command(CMD.PING)
      return true
    } catch {
      return false
    }
  }

  // -------------------------------------------------------------------------
  // capture
  // -------------------------------------------------------------------------

  private async pump(signal: AbortSignal): Promise<void> {
    while (!signal.aborted && this.usb.isOpen) {
      let buf: Uint8Array
      try {
        buf = await this.usb.bulkIn(EP_IN, PKT_LEN)
      } catch {
        if (signal.aborted || !this.usb.isOpen) return
        await sleep(5)
        continue
      }
      if (buf.byteLength < 14) continue
      try {
        this.onPacket(parseUsbPacket(buf))
      } catch {
        // a torn packet is dropped, the next transfer resynchronises.
      }
    }
  }

  private dbm(p: UsbPacket): number {
    const raw = p.rssiCount > 0 ? p.rssiAvg : p.rssiMin
    return raw + this.params.rssiOffset
  }

  private onPacket(p: UsbPacket): void {
    if (p.type === PKT.SPECAN) {
      this.onSpecan(p)
      return
    }
    if (p.type === PKT.LE || p.type === PKT.LE_PROMISC) {
      this.onLe(p)
      return
    }
    if (p.type === PKT.BR) this.onBasicRate(p)
  }

  /** 16 triples of frequency big endian, then a signed CC2400 RSSI byte. */
  private onSpecan(p: UsbPacket): void {
    const d = p.data
    for (let i = 0; i < 16; i++) {
      const f = (d[3 * i] << 8) | d[3 * i + 1]
      const raw = (d[3 * i + 2] << 24) >> 24
      if (f < SPEC_LOW || f > SPEC_HIGH) continue
      this.bins[f - SPEC_LOW] = raw + this.params.rssiOffset
      if (f < this.lastSweepFreq) this.emitSweep()
      this.lastSweepFreq = f
    }
  }

  private emitSweep(): void {
    const now = performance.now()
    // sweeps land faster than a display can use, so publish at 25 fps.
    if (now - this.lastSweepAt < 40) return
    this.lastSweepAt = now
    const frame: Emitted<FftFrame> = {
      kind: 'fft',
      bins: this.bins.slice(),
      centerHz: ((SPEC_LOW + SPEC_HIGH) / 2) * 1e6,
      sampleRate: SPEC_BINS * 1e6,
    }
    this.ctx.emit(frame)
  }

  private onLe(p: UsbPacket): void {
    const adv = parseAdvertisement(p.data)
    if (!adv) return
    const rssi = this.dbm(p)
    const freq = 2402 + p.channel
    const channel = freqToBleChannel(freq)

    const fields: Record<string, unknown> = {
      accessAddress: `0x${adv.accessAddress.toString(16).padStart(8, '0')}`,
      pduType: adv.pduType,
      channel,
      length: adv.length,
    }
    if (adv.advertiser) fields.advertiser = adv.advertiser
    if (adv.flags !== undefined) fields.flags = `0x${adv.flags.toString(16).padStart(2, '0')}`
    if (adv.name) fields.name = adv.name
    if (adv.serviceUuids.length) fields.serviceUuids = adv.serviceUuids
    if (adv.manufacturer) {
      fields.manufacturer = {
        company: adv.manufacturer.company,
        id: `0x${adv.manufacturer.id.toString(16).padStart(4, '0')}`,
        data: hex(adv.manufacturer.bytes),
      }
    }
    if (adv.ads.length) {
      fields.ads = adv.ads.map((ad) => ({ type: ad.name, value: ad.text }))
    }

    const record: Emitted<PacketRecord> = {
      kind: 'packet',
      bytes: adv.frame,
      proto: 'ble',
      channel,
      rssi,
      fields,
      summary: adv.summary,
    }
    this.ctx.emit(record)
  }

  private onBasicRate(p: UsbPacket): void {
    const rssi = this.dbm(p)
    for (const lap of extractLaps(p.data)) {
      const seen = this.laps.get(lap) ?? { count: 0, rssi, clkn: p.clk100ns }
      seen.count += 1
      seen.rssi = rssi
      seen.clkn = p.clk100ns
      this.laps.set(lap, seen)

      const lapHex = lap.toString(16).padStart(6, '0')
      const fields: Record<string, unknown> = {
        lap: `0x${lapHex}`,
        hits: seen.count,
        channel: p.channel,
        clk100ns: p.clk100ns,
      }
      // libubertooth needs repeats before a LAP is worth an address guess.
      if (seen.count >= 12) {
        const uap = (lap >> 4) & 0xff
        fields.uapEstimate = `0x${uap.toString(16).padStart(2, '0')}`
        fields.bdaddrEstimate = `??:??:${uap.toString(16).padStart(2, '0')}:${lapHex.slice(0, 2)}:${lapHex.slice(2, 4)}:${lapHex.slice(4, 6)}`
      }

      const record: Emitted<PacketRecord> = {
        kind: 'packet',
        bytes: p.data.slice(),
        proto: 'bt',
        channel: p.channel,
        rssi,
        fields,
        summary: `LAP ${lapHex}  ${seen.count} hits`,
      }
      this.ctx.emit(record)
    }
  }
}

function handleFor(port: UsbPort): DeviceHandle {
  return {
    kind: 'ubertooth',
    transport: 'webusb',
    uid: port.serial || port.productName,
    label: 'Ubertooth One',
    raw: port,
  }
}

export const ubertoothDriver: DeviceDriver = {
  descriptor: ubertoothDescriptor,

  availableTransports(): TransportKind[] {
    return 'usb' in navigator ? ['webusb'] : []
  },

  async requestAccess(transport: TransportKind): Promise<DeviceHandle | null> {
    if (transport !== 'webusb') throw new Error('the ubertooth one only speaks webusb')
    try {
      const port = await UsbPort.request(USB_FILTERS)
      return handleFor(port)
    } catch {
      return null
    }
  },

  async enumerate(): Promise<DeviceHandle[]> {
    const ports = await UsbPort.paired(USB_FILTERS)
    return ports.map(handleFor)
  },

  async open(handle: DeviceHandle, ctx: DriverContext): Promise<DeviceSession> {
    const port = handle.raw as UsbPort
    // the capture endpoint sits on interface 0 in every shipped firmware.
    await port.claim({ interface: 0 })
    const session = new UbertoothSession(port, ctx)
    await session.init()
    return session
  },
}

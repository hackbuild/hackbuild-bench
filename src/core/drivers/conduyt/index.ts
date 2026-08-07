import {
  ConduytDevice,
  ConduytNAKError,
  ConduytTimeoutError,
  ERR,
  PIN_CAP,
  SUB_MODE,
} from 'conduyt-js'
import type {
  DatastreamDescriptor,
  DatastreamValue,
  HelloResp,
  ModuleDescriptor,
} from 'conduyt-js'
import { WebSerialTransport } from 'conduyt-js/transports/web-serial'
import { BLETransport } from 'conduyt-js/transports/ble'

import { CAPABILITIES } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import { toHex } from '@/core/format'
import { BleLink } from '@/core/transport/webble'
import { SerialPortHandle } from '@/core/transport/webserial'
import type { DeviceDescriptor, TransportKind } from '@/core/types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '../types'
import { matchBoard, mcuProfile } from './profiles'

/**
 * Conduyt boards over Web Serial and Web Bluetooth.
 *
 * Conduyt is a framed binary protocol, so the board is asked what it is rather
 * than assumed: HELLO carries the firmware name and version, a capability
 * bitmask per pin, the i2c and spi bus counts, the loaded modules, and the
 * named datastreams. Everything this driver reports comes from that answer.
 *
 * A board on the same usb bridge chip running some other sketch will open the
 * port fine and then never answer HELLO. That case is reported as needing the
 * conduyt firmware rather than as a dead port.
 */

const PLAYGROUND = 'https://conduyt.io/playground'

/** GATT service the conduyt ble transport looks for. */
const CONDUYT_SERVICE_UUID = '0000cd01-0000-1000-8000-00805f9b34fb'

const BAUD = 115200
const HELLO_TIMEOUT_MS = 4000

/** Addresses a 7 bit i2c scan walks. Below 0x08 and above 0x77 is reserved. */
const I2C_FIRST = 0x08
const I2C_LAST = 0x77

export type ConduytPinMode = 'input' | 'input_pullup' | 'output' | 'pwm' | 'analog'

/** The modes that put current on the pin, so the ones behind the arm confirm. */
const DRIVING_MODES = new Set<ConduytPinMode>(['output', 'pwm'])

const descriptor: DeviceDescriptor = {
  kind: 'conduyt',
  name: 'Conduyt board',
  blurb: 'a board that becomes whatever instrument you need',
  icon: 'microchip',
  transports: ['webserial', 'webble'],
  // what the family can offer. the per unit list comes from HELLO at open.
  capabilities: [CAPABILITIES.GPIO_DRIVE, CAPABILITIES.BUS_READ, CAPABILITIES.BUS_DRIVE],
  params: [],
  serialFilters: [
    { usbVendorId: 0x2341 }, // Arduino
    { usbVendorId: 0x303a }, // Espressif native usb
    { usbVendorId: 0x10c4 }, // CP210x
    { usbVendorId: 0x1a86 }, // CH340
    { usbVendorId: 0x0403 }, // FTDI
    { usbVendorId: 0x2e8a }, // RP2040
    { usbVendorId: 0x239a }, // Adafruit
  ],
  bleFilters: { services: [CONDUYT_SERVICE_UUID] },
  limits: {
    [CAPABILITIES.SERIAL_CONSOLE]:
      'the conduyt link is framed binary and owns the port, so there is no free text console here. flash a plain sketch and open the esp32 driver for that.',
    [CAPABILITIES.BUS_READ]:
      'i2c only, and only on the buses the board reported. spi is in the protocol but not wired up here.',
  },
}

interface SerialRaw {
  port: SerialPort
  vid?: number
  pid?: number
}

interface BleRaw {
  device: BluetoothDevice
}

/**
 * The surface beyond the adapter contract that the conduyt panel drives.
 * Reads are free. Anything that puts current on a pin or bytes on a bus
 * checks the arm state first.
 */
export interface ConduytSession extends DeviceSession {
  /** What the board said about itself, or null when the handshake failed. */
  getHello(): HelloResp | null
  setPinMode(pin: number, mode: ConduytPinMode): Promise<void>
  writePin(pin: number, value: number): Promise<void>
  readPin(pin: number): Promise<number>
  analogRead(pin: number): Promise<number>
  scanI2c(): Promise<number[]>
  i2cRead(addr: number, count: number): Promise<Uint8Array>
  i2cWrite(addr: number, bytes: Uint8Array): Promise<void>
  listModules(): ModuleDescriptor[]
  moduleCommand(name: string, cmd: number, data?: Uint8Array): Promise<Uint8Array>
  listDatastreams(): DatastreamDescriptor[]
  /** Starts a subscription. Call the returned function to stop it. */
  subscribeDatastream(name: string): () => void
  /** Pin events, emitted as readings until the returned function is called. */
  subscribePin(pin: number, analog?: boolean): () => void
  ping(): Promise<void>
  resetBoard(): Promise<void>
}

/**
 * Capabilities this unit actually has, read off HELLO.
 *
 * Serial console is never claimed. The framed link owns the transport, and a
 * second uart on the board is not reachable from the browser, so offering a
 * terminal would be a lie in either case.
 */
function capabilitiesFrom(hello: HelloResp): Capability[] {
  const caps: Capability[] = []
  if (hello.pins.length > 0) caps.push(CAPABILITIES.GPIO_DRIVE)
  if (hello.i2cBuses > 0) caps.push(CAPABILITIES.BUS_READ, CAPABILITIES.BUS_DRIVE)
  return caps
}

/**
 * The modes a pin will take, read off the bitmask it reported. A pin with no
 * adc never gets offered analog, so the panel cannot ask for a mode the
 * firmware would answer PIN_MODE_UNSUPPORTED to.
 */
export function pinModesFor(capabilities: number): ConduytPinMode[] {
  const modes: ConduytPinMode[] = []
  if (capabilities & PIN_CAP.DIGITAL_IN) modes.push('input', 'input_pullup')
  if (capabilities & PIN_CAP.ANALOG_IN) modes.push('analog')
  if (capabilities & PIN_CAP.DIGITAL_OUT) modes.push('output')
  if (capabilities & PIN_CAP.PWM_OUT) modes.push('pwm')
  return modes
}

/** True when the mode puts current on the pin. */
export function modeDrives(mode: ConduytPinMode): boolean {
  return DRIVING_MODES.has(mode)
}

/** What else the pin is wired to, for the cell header. */
export function pinTagsFor(capabilities: number): string[] {
  const tags: string[] = []
  if (capabilities & PIN_CAP.ANALOG_IN) tags.push('adc')
  if (capabilities & PIN_CAP.PWM_OUT) tags.push('pwm')
  if (capabilities & PIN_CAP.I2C_SDA) tags.push('sda')
  if (capabilities & PIN_CAP.I2C_SCL) tags.push('scl')
  if (capabilities & PIN_CAP.SPI) tags.push('spi')
  if (capabilities & PIN_CAP.INTERRUPT) tags.push('int')
  return tags
}

function versionOf(hello: HelloResp): string {
  return hello.firmwareVersion.join('.')
}

function numeric(value: DatastreamValue): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

class Session implements ConduytSession {
  private device: ConduytDevice
  private ctx: DriverContext
  private hello: HelloResp | null
  private info: Record<string, string>
  private stops = new Map<string, () => void>()
  /** Pins this session put in a driving mode, so reset can release them. */
  private driven = new Set<number>()
  private closed = false

  constructor(
    device: ConduytDevice,
    ctx: DriverContext,
    hello: HelloResp,
    info: Record<string, string>,
  ) {
    this.device = device
    this.ctx = ctx
    this.hello = hello
    this.info = info
    ctx.signal.addEventListener('abort', () => {
      void this.close()
    })
  }

  // -- adapter contract -----------------------------------------------------

  getCapabilities(): Capability[] {
    return this.hello ? capabilitiesFrom(this.hello) : []
  }

  getInfo(): Record<string, string> {
    return this.info
  }

  async configure(): Promise<void> {
    // the board takes no host side knobs. baud is fixed by the transport.
  }

  async start(mode: string): Promise<void> {
    if (mode !== 'datastreams') throw new Error(`conduyt has no ${mode} mode`)
    const streams = this.listDatastreams()
    if (!streams.length) throw new Error('the board reported no datastreams to subscribe to')
    for (const ds of streams) this.subscribeDatastream(ds.name)
    this.ctx.log(`subscribed to ${streams.length} datastreams`)
  }

  async stop(): Promise<void> {
    for (const stop of [...this.stops.values()]) stop()
  }

  async resetToSafeState(): Promise<void> {
    await this.stop()
    for (const pin of [...this.driven]) {
      try {
        await this.device.pin(pin).mode('input')
      } catch {
        // the board may already be gone. the rest of the pins still get tried.
      }
    }
    this.driven.clear()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.stop()
    try {
      await this.device.disconnect()
    } catch {
      // the port may already be gone. nothing left to release.
    }
  }

  async health(): Promise<boolean> {
    return !this.closed && this.device.connected
  }

  // -- pins -----------------------------------------------------------------

  getHello(): HelloResp | null {
    return this.hello
  }

  async setPinMode(pin: number, mode: ConduytPinMode): Promise<void> {
    if (DRIVING_MODES.has(mode)) {
      this.requireArmed(CAPABILITIES.GPIO_DRIVE, `set pin ${pin} to ${mode}`)
      this.driven.add(pin)
    } else {
      this.driven.delete(pin)
    }
    await this.device.pin(pin).mode(mode)
    this.ctx.log(`pin ${pin} mode ${mode}`)
  }

  async writePin(pin: number, value: number): Promise<void> {
    this.requireArmed(CAPABILITIES.GPIO_DRIVE, `write pin ${pin}`)
    this.driven.add(pin)
    await this.device.pin(pin).write(value)
    this.emitReading(`pin ${pin}`, value)
  }

  async readPin(pin: number): Promise<number> {
    const value = await this.device.pin(pin).digitalRead()
    this.emitReading(`pin ${pin}`, value)
    return value
  }

  async analogRead(pin: number): Promise<number> {
    const value = await this.device.pin(pin).analogRead()
    this.emitReading(`pin ${pin}`, value, 'counts')
    return value
  }

  subscribePin(pin: number, analog = false): () => void {
    const key = `pin:${pin}`
    const running = this.stops.get(key)
    if (running) return running

    const iterator = this.device
      .pin(pin)
      .subscribe({ mode: analog ? SUB_MODE.ANALOG_POLL : SUB_MODE.CHANGE, intervalMs: 100 })
      [Symbol.asyncIterator]()

    return this.pump(key, iterator, (value: number) => {
      this.emitReading(`pin ${pin}`, value, analog ? 'counts' : undefined)
    })
  }

  // -- i2c ------------------------------------------------------------------

  /**
   * Walk the 7 bit address space with a one byte read. Conduyt has no scan
   * command, so a device is present when the read is acknowledged and absent
   * when the board answers I2C_NACK.
   */
  async scanI2c(): Promise<number[]> {
    this.requireBus()
    const found: number[] = []
    for (let addr = I2C_FIRST; addr <= I2C_LAST; addr++) {
      if (this.ctx.signal.aborted || this.closed) break
      try {
        await this.device.i2c(0).read(addr, 1)
        found.push(addr)
      } catch (err) {
        if (err instanceof ConduytNAKError && err.code === ERR.I2C_NACK) continue
        if (err instanceof ConduytTimeoutError) {
          throw new Error(
            `the board stopped answering at address 0x${addr.toString(16)}. check the bus is not held low and try again.`,
          )
        }
        throw err
      }
    }
    this.ctx.log(`i2c scan found ${found.length} devices`)
    return found
  }

  async i2cRead(addr: number, count: number): Promise<Uint8Array> {
    this.requireBus()
    return this.device.i2c(0).read(addr, count)
  }

  async i2cWrite(addr: number, bytes: Uint8Array): Promise<void> {
    this.requireBus()
    this.requireArmed(
      CAPABILITIES.BUS_DRIVE,
      `write ${bytes.length} bytes to 0x${addr.toString(16)}`,
    )
    await this.device.i2c(0).write(addr, bytes)
    this.ctx.log(`i2c wrote ${toHex(bytes)} to 0x${addr.toString(16)}`)
  }

  // -- modules and datastreams ----------------------------------------------

  listModules(): ModuleDescriptor[] {
    return this.hello?.modules ?? []
  }

  async moduleCommand(name: string, cmd: number, data?: Uint8Array): Promise<Uint8Array> {
    this.requireArmed(CAPABILITIES.GPIO_DRIVE, `send command 0x${cmd.toString(16)} to ${name}`)
    const mod = this.listModules().find((m) => m.name === name)
    if (!mod) throw new Error(`the board reports no module called ${name}`)
    for (const pin of mod.pins) this.driven.add(pin)
    return this.device.module(name).cmd(cmd, data ?? new Uint8Array(0))
  }

  listDatastreams(): DatastreamDescriptor[] {
    return this.hello?.datastreams ?? []
  }

  subscribeDatastream(name: string): () => void {
    const key = `ds:${name}`
    const running = this.stops.get(key)
    if (running) return running

    const ds = this.listDatastreams().find((d) => d.name === name)
    if (!ds) throw new Error(`the board reports no datastream called ${name}`)

    const iterator = this.device.datastream(name).subscribe()[Symbol.asyncIterator]()
    return this.pump(key, iterator, (value: DatastreamValue) => {
      const n = numeric(value)
      if (n === null) this.ctx.log(`${name}: ${String(value)}`)
      else this.emitReading(name, n, ds.unit || undefined)
    })
  }

  // -- link -----------------------------------------------------------------

  async ping(): Promise<void> {
    await this.device.ping()
  }

  async resetBoard(): Promise<void> {
    await this.device.reset()
    this.driven.clear()
    this.ctx.log('board reset, it comes back with every pin as an input')
  }

  // -- internals ------------------------------------------------------------

  private requireArmed(cap: Capability, action: string): void {
    if (this.ctx.isArmed(cap)) return
    const label = cap === CAPABILITIES.BUS_DRIVE ? 'bus drive' : 'gpio drive'
    throw new Error(`${label} is not armed. arm ${label} to ${action}.`)
  }

  private requireBus(): void {
    if ((this.hello?.i2cBuses ?? 0) < 1) {
      throw new Error('the board reported no i2c bus, so there is nothing to talk to.')
    }
  }

  private emitReading(name: string, value: number, unit?: string): void {
    this.ctx.emit(unit ? { kind: 'reading', name, value, unit } : { kind: 'reading', name, value })
  }

  /**
   * Drain a conduyt subscription into the bus. The iterators never end on
   * their own, so the stop function is the only way out and it also sends the
   * unsubscribe the firmware needs.
   */
  private pump<T>(
    key: string,
    iterator: AsyncIterator<T>,
    onValue: (value: T) => void,
  ): () => void {
    let stopped = false
    const stop = (): void => {
      if (stopped) return
      stopped = true
      this.stops.delete(key)
      void iterator.return?.()
    }
    this.stops.set(key, stop)

    void (async () => {
      while (!stopped && !this.closed) {
        const next = await iterator.next()
        if (next.done) break
        onValue(next.value)
      }
    })().catch((err: unknown) => {
      stop()
      this.ctx.log(`${key} stopped: ${err instanceof Error ? err.message : String(err)}`)
    })

    return stop
  }
}

function labelFor(vid?: number, pid?: number, pinCount?: number): string {
  const board = matchBoard({ vid, pid, pinCount })
  return board?.name ?? 'Conduyt board'
}

function serialHandle(handle: SerialPortHandle): DeviceHandle {
  const info = handle.info
  const vid = info.usbVendorId
  const pid = info.usbProductId
  const raw: SerialRaw = { port: handle.port, vid, pid }
  return {
    kind: 'conduyt',
    transport: 'webserial',
    uid: `conduyt-${vid?.toString(16) ?? '0'}-${pid?.toString(16) ?? '0'}`,
    label: labelFor(vid, pid),
    raw,
  }
}

async function connectDevice(
  handle: DeviceHandle,
  ctx: DriverContext,
): Promise<{ device: ConduytDevice; hello: HelloResp; vid?: number; pid?: number }> {
  const isSerial = handle.transport === 'webserial'
  const serial = handle.raw as SerialRaw
  const ble = handle.raw as BleRaw

  const transport = isSerial
    ? new WebSerialTransport({ port: serial.port, baudRate: BAUD })
    : new BLETransport({ device: ble.device, serviceUUID: CONDUYT_SERVICE_UUID })

  const device = new ConduytDevice(transport, { timeoutMs: HELLO_TIMEOUT_MS })

  let hello: HelloResp
  try {
    hello = await device.connect()
  } catch (err) {
    try {
      await device.disconnect()
    } catch {
      // the transport may have failed before it opened anything.
    }
    if (err instanceof ConduytTimeoutError) {
      throw new Error(
        `the board answered on ${isSerial ? 'serial' : 'ble'} but did not speak conduyt. it probably needs the conduyt firmware flashed, which you can do at ${PLAYGROUND}`,
      )
    }
    throw err
  }

  ctx.log(`hello from ${hello.firmwareName} ${versionOf(hello)}`)
  return { device, hello, vid: isSerial ? serial.vid : undefined, pid: isSerial ? serial.pid : undefined }
}

export const conduytDriver: DeviceDriver = {
  descriptor,

  availableTransports(): TransportKind[] {
    const out: TransportKind[] = []
    if ('serial' in navigator) out.push('webserial')
    if ('bluetooth' in navigator) out.push('webble')
    return out
  },

  async requestAccess(transport: TransportKind): Promise<DeviceHandle | null> {
    if (transport === 'webserial') {
      let port: SerialPortHandle
      try {
        port = await SerialPortHandle.request(descriptor.serialFilters)
      } catch {
        return null
      }
      return serialHandle(port)
    }

    if (transport === 'webble') {
      let link: BleLink
      try {
        link = await BleLink.request(descriptor.bleFilters)
      } catch {
        return null
      }
      const raw: BleRaw = { device: link.device }
      return {
        kind: 'conduyt',
        transport: 'webble',
        uid: `conduyt-ble-${link.device.id}`,
        label: link.name,
        raw,
      }
    }

    return null
  },

  async enumerate(): Promise<DeviceHandle[]> {
    if (!('serial' in navigator)) return []
    const ports = await SerialPortHandle.paired()
    return ports.map((p) => serialHandle(p))
  },

  async open(handle: DeviceHandle, ctx: DriverContext): Promise<DeviceSession> {
    const { device, hello, vid, pid } = await connectDevice(handle, ctx)

    const board = matchBoard({ vid, pid, pinCount: hello.pins.length })
    const mcu = board ? mcuProfile(board.mcu) : null
    const analog = hello.pins.filter((p) => (p.capabilities & PIN_CAP.ANALOG_IN) !== 0).length

    const info: Record<string, string> = {
      firmware: `${hello.firmwareName} ${versionOf(hello)}`,
      // the panel reads this back through boardProfile to label the pins.
      'board id': board?.id ?? '',
      board: board?.name ?? 'not identified from usb id and pin count',
      mcu: mcu?.name ?? 'reported by id only',
      'mcu id': toHex(hello.mcuId, ''),
      pins: `${hello.pins.length}, ${analog} analog`,
      'i2c buses': String(hello.i2cBuses),
      modules: hello.modules.length ? hello.modules.map((m) => m.name).join(', ') : 'none loaded',
      datastreams: hello.datastreams.length
        ? hello.datastreams.map((d) => d.name).join(', ')
        : 'none declared',
      ota: hello.otaCapable ? 'accepted over this link' : 'not offered',
      transport: handle.transport === 'webserial' ? `web serial at ${BAUD} baud` : 'web bluetooth',
    }
    ctx.setInfo(info)

    ctx.log(
      `${hello.pins.length} pins, ${hello.i2cBuses} i2c, ${hello.spiBuses} spi, ${hello.modules.length} modules, ${hello.datastreams.length} datastreams, max payload ${hello.maxPayload}`,
    )
    if (hello.modules.length) {
      ctx.log(`modules: ${hello.modules.map((m) => `${m.name} v${m.versionMajor}.${m.versionMinor}`).join(', ')}`)
    }

    return new Session(device, ctx, hello, info)
  },
}

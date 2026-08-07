import type { Capability } from '../../capabilities'
import { CAPABILITIES } from '../../capabilities'
import type { DeviceDescriptor, TransportKind } from '../../types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '../types'
import { COMMON_BAUDS, SerialPortHandle, scorePrintable } from '../../transport/webserial'
import type { PinMode } from './protocol'
import { encodeI2cScan, encodePin, encodeServo, isI2cScanDone, parseI2cAddress } from './protocol'

/**
 * ESP32 over Web Serial. A general board that stands in for gear you do not
 * have: a serial console, a set of gpio you can drive, an i2c bus you can
 * scan, and a flash you can rewrite.
 *
 * The pin, servo, and i2c calls speak the line protocol in protocol.ts, which
 * the board must be running. The console works against any board.
 */

const descriptor: DeviceDescriptor = {
  kind: 'esp32',
  name: 'ESP32',
  blurb: 'a board that fills in for gear you do not have',
  icon: 'microchip',
  transports: ['webserial'],
  capabilities: [
    CAPABILITIES.SERIAL_CONSOLE,
    CAPABILITIES.GPIO_DRIVE,
    CAPABILITIES.BUS_READ,
    CAPABILITIES.BUS_DRIVE,
    CAPABILITIES.FLASH_PROGRAM,
  ],
  params: [
    {
      key: 'baud',
      label: 'baud',
      min: 9600,
      max: 921600,
      default: 115200,
      choices: [9600, 74880, 115200, 230400, 921600],
    },
  ],
  serialFilters: [
    { usbVendorId: 0x10c4 }, // CP210x
    { usbVendorId: 0x1a86 }, // CH340
    { usbVendorId: 0x0403 }, // FTDI
    { usbVendorId: 0x303a }, // native ESP32-S2/S3 CDC
  ],
}

const DEFAULT_BAUD = 115200

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}

class Esp32Session implements DeviceSession {
  private port: SerialPortHandle
  private ctx: DriverContext
  private baud: number
  private emitting = false
  private closed = false
  private loopAbort: AbortController | null = null
  private lineHandlers = new Set<(line: string) => void>()

  constructor(port: SerialPortHandle, ctx: DriverContext, baud: number) {
    this.port = port
    this.ctx = ctx
    this.baud = baud
  }

  begin(): void {
    this.ctx.signal.addEventListener('abort', () => {
      void this.close()
    })
    this.startLoop()
  }

  getCapabilities(): Capability[] {
    return [
      CAPABILITIES.SERIAL_CONSOLE,
      CAPABILITIES.GPIO_DRIVE,
      CAPABILITIES.BUS_READ,
      CAPABILITIES.BUS_DRIVE,
      CAPABILITIES.FLASH_PROGRAM,
    ]
  }

  getInfo(): Record<string, string> {
    return { transport: 'web serial', baud: String(this.baud) }
  }

  async configure(params: Record<string, number>): Promise<void> {
    const next = Math.round(params.baud ?? this.baud)
    if (next !== this.baud) await this.reopenAt(next)
  }

  async start(mode: string): Promise<void> {
    if (mode !== 'console') throw new Error(`esp32 has no ${mode} mode`)
    this.emitting = true
    this.ctx.log(`console reading at ${this.baud} baud`)
  }

  async stop(): Promise<void> {
    this.emitting = false
  }

  async resetToSafeState(): Promise<void> {
    this.emitting = false
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.loopAbort?.abort()
    this.loopAbort = null
    await this.port.disconnect()
  }

  async health(): Promise<boolean> {
    return !this.closed && this.port.isOpen
  }

  // extra surface the terminal and flasher tools drive ---------------------

  /** Send a line to the board and echo it as a tx artifact. */
  async write(text: string): Promise<void> {
    const out = text.endsWith('\n') ? text : `${text}\n`
    await this.port.write(out)
    this.emitLine(text.replace(/\r?\n$/, ''), 'tx')
  }

  /**
   * Try every common baud, sample each for 600 ms, and keep the one whose
   * traffic looks most like printable line structured text. Returns the winner
   * and leaves the port open at it.
   */
  async autoBaud(): Promise<number> {
    const wasEmitting = this.emitting
    this.emitting = false
    this.loopAbort?.abort()
    this.loopAbort = null
    await this.port.disconnect()

    let best = this.baud
    let bestScore = -1
    for (const baud of COMMON_BAUDS) {
      this.emitLine(`probing ${baud} baud`, 'note')
      try {
        await this.port.connect({ baudRate: baud })
      } catch {
        this.emitLine(`cannot open at ${baud}`, 'note')
        continue
      }
      const bytes = await this.collectFor(600)
      const score = scorePrintable(bytes)
      this.emitLine(`${baud}: score ${score.toFixed(2)} over ${bytes.length} bytes`, 'note')
      await this.port.disconnect()
      if (score > bestScore) {
        bestScore = score
        best = baud
      }
    }

    await this.port.connect({ baudRate: best })
    this.baud = best
    this.emitting = wasEmitting
    this.startLoop()
    this.emitLine(`selected ${best} baud`, 'note')
    return best
  }

  /** Configure or drive a gpio. Consequential, so it needs gpio drive armed. */
  async setPin(pin: number, mode: PinMode, value: number): Promise<void> {
    if (!this.ctx.isArmed(CAPABILITIES.GPIO_DRIVE)) {
      throw new Error('gpio drive is not armed. arm gpio drive to set a pin.')
    }
    const cmd = encodePin(pin, mode, value)
    await this.port.write(cmd)
    this.emitLine(cmd.trimEnd(), 'tx')
  }

  /** Probe the i2c bus. A read, so no arming. Returns the addresses found. */
  async scanI2c(): Promise<number[]> {
    const addrs: number[] = []
    const done = new Promise<void>((resolve) => {
      const handler = (line: string): void => {
        const addr = parseI2cAddress(line)
        if (addr !== null) addrs.push(addr)
        if (isI2cScanDone(line)) {
          clearTimeout(timer)
          this.lineHandlers.delete(handler)
          resolve()
        }
      }
      const timer = setTimeout(() => {
        this.lineHandlers.delete(handler)
        resolve()
      }, 3000)
      this.lineHandlers.add(handler)
    })
    await this.port.write(encodeI2cScan())
    this.emitLine('I2C SCAN', 'tx')
    await done
    return addrs
  }

  /** Move a servo. Drives a pin, so it needs gpio drive armed. */
  async setServo(pin: number, degrees: number): Promise<void> {
    if (!this.ctx.isArmed(CAPABILITIES.GPIO_DRIVE)) {
      throw new Error('gpio drive is not armed. arm gpio drive to move a servo.')
    }
    const cmd = encodeServo(pin, degrees)
    await this.port.write(cmd)
    this.emitLine(cmd.trimEnd(), 'tx')
  }

  /**
   * Drive the modem lines to put the chip in the serial bootloader. This is the
   * classic auto reset sequence: RTS toggles EN, DTR toggles GPIO0. Entering
   * the bootloader halts the running program to write flash, so it needs flash
   * write armed.
   */
  async enterBootloader(): Promise<void> {
    if (!this.ctx.isArmed(CAPABILITIES.FLASH_PROGRAM)) {
      throw new Error('flash write is not armed. arm flash write to enter the bootloader.')
    }
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: true })
    await sleep(100)
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: false })
    await sleep(50)
    await this.port.setSignals({ dataTerminalReady: false })
  }

  /** Pulse EN to reboot the board into the running program. */
  async reset(): Promise<void> {
    await this.port.setSignals({ requestToSend: true })
    await sleep(100)
    await this.port.setSignals({ requestToSend: false })
  }

  // internals --------------------------------------------------------------

  private startLoop(): void {
    const ac = new AbortController()
    this.loopAbort = ac
    void this.port
      .readLines((line) => this.onLine(line), ac.signal)
      .catch(() => {
        // the reader ends on disconnect or abort. nothing to recover here.
      })
  }

  private onLine(line: string): void {
    if (this.emitting) this.emitLine(line, 'rx')
    for (const h of [...this.lineHandlers]) h(line)
  }

  private emitLine(text: string, stream: 'rx' | 'tx' | 'note'): void {
    const rec = { kind: 'line' as const, text, stream }
    this.ctx.emit(rec)
  }

  private collectFor(ms: number): Promise<Uint8Array> {
    return new Promise((resolve) => {
      const chunks: Uint8Array[] = []
      const ac = new AbortController()
      const finish = (): void => resolve(concatBytes(chunks))
      const timer = setTimeout(() => {
        ac.abort()
        finish()
      }, ms)
      void this.port
        .read((c) => chunks.push(c.slice()), ac.signal)
        .catch(() => {
          clearTimeout(timer)
          finish()
        })
    })
  }

  private async reopenAt(baud: number): Promise<void> {
    this.loopAbort?.abort()
    this.loopAbort = null
    await this.port.disconnect()
    await this.port.connect({ baudRate: baud })
    this.baud = baud
    this.startLoop()
  }
}

function handleFor(port: SerialPortHandle): DeviceHandle {
  const info = port.info
  const vid = info.usbVendorId?.toString(16) ?? '0'
  const pid = info.usbProductId?.toString(16) ?? '0'
  return {
    kind: 'esp32',
    transport: 'webserial',
    uid: `esp32-${vid}-${pid}`,
    label: 'ESP32',
    raw: { port },
  }
}

export const esp32Driver: DeviceDriver = {
  descriptor,

  availableTransports(): TransportKind[] {
    return 'serial' in navigator ? ['webserial'] : []
  },

  async requestAccess(transport: TransportKind): Promise<DeviceHandle | null> {
    if (transport !== 'webserial') return null
    let port: SerialPortHandle
    try {
      port = await SerialPortHandle.request(descriptor.serialFilters)
    } catch {
      return null
    }
    return handleFor(port)
  },

  async enumerate(): Promise<DeviceHandle[]> {
    const ports = await SerialPortHandle.paired()
    return ports.map((p) => handleFor(p))
  },

  async open(handle: DeviceHandle, ctx: DriverContext): Promise<DeviceSession> {
    const { port } = handle.raw as { port: SerialPortHandle }
    await port.connect({ baudRate: DEFAULT_BAUD })
    const session = new Esp32Session(port, ctx, DEFAULT_BAUD)
    session.begin()
    ctx.setInfo({ transport: 'web serial', baud: String(DEFAULT_BAUD) })
    return session
  },
}

export type { Esp32Session }

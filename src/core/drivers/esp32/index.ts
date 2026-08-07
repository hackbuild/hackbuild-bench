import type { Capability } from '../../capabilities'
import { CAPABILITIES } from '../../capabilities'
import type { DeviceDescriptor, TransportKind } from '../../types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '../types'
import { COMMON_BAUDS, SerialPortHandle, scorePrintable } from '../../transport/webserial'

/**
 * ESP32 over Web Serial. A serial console with auto baud, and the modem line
 * dance that drops the chip into its bootloader so flash can be rewritten.
 *
 * Pins, i2c, and servos are not here. Whatever sketch the board is running
 * decides what a line of text means, so there is nothing honest to offer until
 * the board runs a protocol the bench knows. Flash conduyt and the board comes
 * back as a conduyt device with a real pin grid.
 */

const descriptor: DeviceDescriptor = {
  kind: 'esp32',
  name: 'ESP32',
  blurb: 'serial console and flash, pin control comes from flashing conduyt',
  icon: 'microchip',
  transports: ['webserial'],
  capabilities: [CAPABILITIES.SERIAL_CONSOLE, CAPABILITIES.FLASH_PROGRAM],
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
    return [CAPABILITIES.SERIAL_CONSOLE, CAPABILITIES.FLASH_PROGRAM]
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

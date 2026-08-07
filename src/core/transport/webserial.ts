/**
 * Web Serial transport. Byte in, byte out, plus the line reader and the
 * framed reader the protocol drivers need.
 */

export interface SerialOpenOptions {
  baudRate: number
  dataBits?: 7 | 8
  stopBits?: 1 | 2
  parity?: 'none' | 'even' | 'odd'
  flowControl?: 'none' | 'hardware'
  bufferSize?: number
}

export class SerialPortHandle {
  readonly port: SerialPort
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private open = false

  constructor(port: SerialPort) {
    this.port = port
  }

  static async request(
    filters?: Array<{ usbVendorId: number; usbProductId?: number }>,
  ): Promise<SerialPortHandle> {
    const port = await navigator.serial.requestPort(filters?.length ? { filters } : {})
    return new SerialPortHandle(port)
  }

  static async paired(): Promise<SerialPortHandle[]> {
    const ports = await navigator.serial.getPorts()
    return ports.map((p) => new SerialPortHandle(p))
  }

  get info(): SerialPortInfo {
    return this.port.getInfo()
  }

  get isOpen(): boolean {
    return this.open
  }

  async connect(opts: SerialOpenOptions): Promise<void> {
    await this.port.open({
      baudRate: opts.baudRate,
      dataBits: opts.dataBits ?? 8,
      stopBits: opts.stopBits ?? 1,
      parity: opts.parity ?? 'none',
      flowControl: opts.flowControl ?? 'none',
      bufferSize: opts.bufferSize ?? 8192,
    })
    this.reader = this.port.readable?.getReader() ?? null
    this.writer = this.port.writable?.getWriter() ?? null
    this.open = true
  }

  async disconnect(): Promise<void> {
    this.open = false
    try {
      await this.reader?.cancel()
    } catch {
      // already cancelled or the device vanished.
    }
    this.reader?.releaseLock()
    this.reader = null
    try {
      await this.writer?.close()
    } catch {
      // the stream may already be errored.
    }
    this.writer?.releaseLock()
    this.writer = null
    try {
      await this.port.close()
    } catch {
      // unplugged.
    }
  }

  /** Toggle the modem lines. ESP32 and Arduino boot mode entry needs these. */
  async setSignals(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void> {
    await this.port.setSignals(signals)
  }

  async write(data: Uint8Array | string): Promise<void> {
    if (!this.writer) throw new Error('serial port is not open')
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    await this.writer.write(bytes)
  }

  /** Raw byte stream until the signal aborts. */
  async read(onChunk: (chunk: Uint8Array) => void, signal: AbortSignal): Promise<void> {
    while (this.open && !signal.aborted) {
      if (!this.reader) return
      const { value, done } = await this.reader.read()
      if (done) return
      if (value?.byteLength) onChunk(value)
    }
  }

  /** Newline delimited text, with a carry buffer across chunks. */
  async readLines(onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    const decoder = new TextDecoder()
    let carry = ''
    await this.read((chunk) => {
      carry += decoder.decode(chunk, { stream: true })
      const parts = carry.split(/\r?\n/)
      carry = parts.pop() ?? ''
      for (const line of parts) onLine(line)
    }, signal)
  }
}

/**
 * Try a list of baud rates and score each by how much printable, line
 * structured text comes back. Used by the terminal auto baud button.
 */
export const COMMON_BAUDS = [
  9600, 115200, 57600, 38400, 19200, 4800, 230400, 460800, 921600, 74880, 2400,
]

export function scorePrintable(bytes: Uint8Array): number {
  if (!bytes.length) return 0
  let printable = 0
  let newlines = 0
  for (const b of bytes) {
    if (b === 0x0a || b === 0x0d) {
      newlines++
      printable++
    } else if (b === 0x09 || (b >= 0x20 && b <= 0x7e)) {
      printable++
    }
  }
  const ratio = printable / bytes.length
  // a stream with line structure is far more likely to be the right baud than
  // one that is merely printable by chance.
  return ratio + Math.min(newlines / 8, 0.5)
}

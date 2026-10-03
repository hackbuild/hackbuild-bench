/**
 * WebUSB transport. Drivers use this, never navigator.usb directly.
 *
 * Control transfers, bulk reads, and a cancellable streaming loop with the
 * queue depth the SDR drivers need to keep up with a 2 Msps device.
 */

export interface UsbOpenOptions {
  configuration?: number
  interface: number
  alternate?: number
}

export class UsbPort {
  readonly device: USBDevice
  private iface = 0
  private open = false

  constructor(device: USBDevice) {
    this.device = device
  }

  static async request(filters: USBDeviceFilter[]): Promise<UsbPort> {
    const device = await navigator.usb.requestDevice({ filters })
    return new UsbPort(device)
  }

  static async paired(filters: USBDeviceFilter[]): Promise<UsbPort[]> {
    const devices = await navigator.usb.getDevices()
    const match = devices.filter((d) =>
      filters.some(
        (f) =>
          (f.vendorId === undefined || f.vendorId === d.vendorId) &&
          (f.productId === undefined || f.productId === d.productId),
      ),
    )
    return match.map((d) => new UsbPort(d))
  }

  get serial(): string {
    return this.device.serialNumber ?? ''
  }

  get productName(): string {
    return this.device.productName ?? 'usb device'
  }

  get productId(): number {
    return this.device.productId
  }

  async claim(opts: UsbOpenOptions): Promise<void> {
    if (!this.device.opened) await this.device.open()
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(opts.configuration ?? 1)
    }
    this.iface = opts.interface
    try {
      await this.device.claimInterface(this.iface)
    } catch (err) {
      // release() skips a port that never claimed, so the open is undone here.
      try {
        await this.device.close()
      } catch {
        // already closed or unplugged.
      }
      throw err
    }
    if (opts.alternate !== undefined) {
      await this.device.selectAlternateInterface(this.iface, opts.alternate)
    }
    this.open = true
  }

  async release(): Promise<void> {
    if (!this.open) return
    this.open = false
    try {
      await this.device.releaseInterface(this.iface)
    } catch {
      // the device may already be gone. closing is still worth attempting.
    }
    try {
      await this.device.close()
    } catch {
      // unplugged mid-close.
    }
  }

  get isOpen(): boolean {
    return this.open && this.device.opened
  }

  /** Vendor control transfer, device to host. */
  async controlIn(request: number, value: number, index: number, length: number): Promise<DataView> {
    const r = await this.device.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request, value, index },
      length,
    )
    if (r.status !== 'ok' || !r.data) throw new Error(`control in ${request} failed: ${r.status}`)
    return r.data
  }

  /** Vendor control transfer, host to device. */
  async controlOut(
    request: number,
    value: number,
    index: number,
    data?: BufferSource,
  ): Promise<void> {
    const r = await this.device.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request, value, index },
      data,
    )
    if (r.status !== 'ok') throw new Error(`control out ${request} failed: ${r.status}`)
  }

  async bulkIn(endpoint: number, length: number): Promise<Uint8Array> {
    const r = await this.device.transferIn(endpoint, length)
    if (r.status === 'stall') {
      await this.device.clearHalt('in', endpoint)
      throw new Error(`endpoint ${endpoint} stalled`)
    }
    if (!r.data) return new Uint8Array(0)
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength)
  }

  async bulkOut(endpoint: number, data: BufferSource): Promise<void> {
    const r = await this.device.transferOut(endpoint, data)
    if (r.status !== 'ok') throw new Error(`bulk out ${endpoint} failed: ${r.status}`)
  }

  /**
   * Read a bulk endpoint continuously with several transfers in flight, so the
   * device is never waiting on the JS event loop between packets. Returns when
   * the signal aborts or the device closes, and throws the first transfer
   * failure so the caller can say what stopped.
   */
  async stream(
    endpoint: number,
    packetSize: number,
    depth: number,
    onChunk: (chunk: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return
    // a failure in one reader ends the others too, otherwise the read carries
    // on at a fraction of its depth with nothing said.
    const stop = new AbortController()
    const relay = (): void => stop.abort()
    signal.addEventListener('abort', relay)

    const pump = async (): Promise<void> => {
      while (!stop.signal.aborted && this.isOpen) {
        try {
          const chunk = await this.bulkIn(endpoint, packetSize)
          // a transfer already in flight when the signal aborts still lands
          // here. delivering it emits samples after the caller has stopped.
          if (stop.signal.aborted) return
          if (chunk.byteLength) onChunk(chunk)
        } catch (err) {
          if (stop.signal.aborted || !this.isOpen) return
          stop.abort()
          throw err
        }
      }
    }

    const readers: Array<Promise<void>> = []
    for (let i = 0; i < depth; i++) readers.push(pump())

    try {
      const results = await Promise.allSettled(readers)
      const failed = results.find((r) => r.status === 'rejected')
      if (failed) throw (failed as PromiseRejectedResult).reason
    } finally {
      signal.removeEventListener('abort', relay)
    }
  }
}

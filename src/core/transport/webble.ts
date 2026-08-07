/**
 * Web Bluetooth transport. GATT central only.
 *
 * The browser cannot sniff. It connects to one peripheral at a time and reads,
 * writes, or subscribes to characteristics. Anything that needs passive
 * capture goes to the Ubertooth driver instead.
 */

export interface GattCharacteristic {
  uuid: string
  service: string
  properties: string[]
}

export class BleLink {
  readonly device: BluetoothDevice
  private server: BluetoothRemoteGATTServer | null = null
  private subscriptions = new Map<string, BluetoothRemoteGATTCharacteristic>()

  constructor(device: BluetoothDevice) {
    this.device = device
  }

  static async request(filters?: {
    services?: BluetoothServiceUUID[]
    namePrefix?: string
  }): Promise<BleLink> {
    const opts: RequestDeviceOptions = filters?.services?.length || filters?.namePrefix
      ? {
          filters: [
            ...(filters.services?.length ? [{ services: filters.services }] : []),
            ...(filters.namePrefix ? [{ namePrefix: filters.namePrefix }] : []),
          ],
          optionalServices: filters.services ?? [],
        }
      : { acceptAllDevices: true, optionalServices: [] }
    const device = await navigator.bluetooth.requestDevice(opts)
    return new BleLink(device)
  }

  get name(): string {
    return this.device.name ?? 'ble peripheral'
  }

  get isOpen(): boolean {
    return this.server?.connected ?? false
  }

  async connect(): Promise<void> {
    if (!this.device.gatt) throw new Error('peripheral exposes no gatt server')
    this.server = await this.device.gatt.connect()
  }

  async disconnect(): Promise<void> {
    for (const ch of this.subscriptions.values()) {
      try {
        await ch.stopNotifications()
      } catch {
        // link already dropped.
      }
    }
    this.subscriptions.clear()
    this.server?.disconnect()
    this.server = null
  }

  onDisconnect(fn: () => void): void {
    this.device.addEventListener('gattserverdisconnected', fn)
  }

  /** Walk every service and characteristic the peripheral will show us. */
  async enumerate(): Promise<GattCharacteristic[]> {
    if (!this.server) throw new Error('not connected')
    const out: GattCharacteristic[] = []
    const services = await this.server.getPrimaryServices()
    for (const svc of services) {
      let chars: BluetoothRemoteGATTCharacteristic[] = []
      try {
        chars = await svc.getCharacteristics()
      } catch {
        // some services refuse enumeration. skip rather than fail the walk.
        continue
      }
      for (const c of chars) {
        const props: string[] = []
        if (c.properties.read) props.push('read')
        if (c.properties.write) props.push('write')
        if (c.properties.writeWithoutResponse) props.push('writeNR')
        if (c.properties.notify) props.push('notify')
        if (c.properties.indicate) props.push('indicate')
        out.push({ uuid: c.uuid, service: svc.uuid, properties: props })
      }
    }
    return out
  }

  private async char(service: string, uuid: string): Promise<BluetoothRemoteGATTCharacteristic> {
    if (!this.server) throw new Error('not connected')
    const svc = await this.server.getPrimaryService(service)
    return svc.getCharacteristic(uuid)
  }

  async read(service: string, uuid: string): Promise<Uint8Array> {
    const c = await this.char(service, uuid)
    const v = await c.readValue()
    return new Uint8Array(v.buffer)
  }

  async write(service: string, uuid: string, data: Uint8Array, withResponse = true): Promise<void> {
    const c = await this.char(service, uuid)
    // the dom types pin BufferSource to ArrayBuffer backed views, so hand the
    // characteristic a view the checker can prove is not shared memory.
    const view = new Uint8Array(data.length)
    view.set(data)
    if (withResponse) await c.writeValueWithResponse(view)
    else await c.writeValueWithoutResponse(view)
  }

  async subscribe(
    service: string,
    uuid: string,
    onValue: (bytes: Uint8Array) => void,
  ): Promise<void> {
    const c = await this.char(service, uuid)
    c.addEventListener('characteristicvaluechanged', () => {
      const v = c.value
      if (v) onValue(new Uint8Array(v.buffer))
    })
    await c.startNotifications()
    this.subscriptions.set(`${service}/${uuid}`, c)
  }
}

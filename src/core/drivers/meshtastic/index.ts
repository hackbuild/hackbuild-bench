import type { Capability } from '../../capabilities'
import { CAPABILITIES } from '../../capabilities'
import type { DeviceDescriptor, TransportKind } from '../../types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '../types'
import { SerialPortHandle } from '../../transport/webserial'
import { BleLink } from '../../transport/webble'
import { StreamFramer, encodeFrame } from './framing'
import { decodeMessage } from './protobuf'
import type { DecodedField } from './protobuf'

/**
 * Meshtastic over Web Serial and Web Bluetooth, talking to the radio directly
 * with no phone app in the path. The bench reads the node database and text
 * messages the radio reports, and can send text when mesh tx is armed.
 *
 * FromRadio field numbers this driver reads, from the Meshtastic mesh proto:
 *   2  packet      MeshPacket
 *   3  my_info     MyNodeInfo
 *   4  node_info   NodeInfo
 *
 * MeshPacket fields:
 *   1  from    fixed32
 *   2  to      fixed32
 *   3  channel varint
 *   4  decoded Data
 *
 * Data fields:
 *   1  portnum varint (1 is TEXT_MESSAGE_APP)
 *   2  payload bytes
 *
 * NodeInfo fields:
 *   1  num      varint
 *   2  user     User
 *   3  position Position
 *   6  device_metrics DeviceMetrics
 *
 * User fields:      2 long_name, 3 short_name.
 * Position fields:  1 latitude_i sfixed32, 2 longitude_i sfixed32.
 * DeviceMetrics:    1 battery_level varint.
 * MyNodeInfo:       1 my_node_num varint.
 */

const SERVICE = '6ba1b218-15a8-461f-9fa8-5dcae273eafd'
const CH_TORADIO = 'f75c76d2-129e-4dad-a1dd-7866124401e7'
const CH_FROMRADIO = '2c55e69e-4993-11ed-b878-0242ac120002'
const CH_FROMNUM = 'ed9da18c-a800-4f66-a670-aa7547e34453'

const PORTNUM_TEXT = 1
const BROADCAST = 0xffffffff
const SERIAL_BAUD = 115200

const descriptor: DeviceDescriptor = {
  kind: 'meshtastic',
  name: 'Meshtastic',
  blurb: 'a mesh radio you can read and write',
  icon: 'tower-broadcast',
  transports: ['webserial', 'webble'],
  capabilities: [CAPABILITIES.MESH_RX, CAPABILITIES.MESH_TX, CAPABILITIES.GNSS_FIX],
  params: [],
  serialFilters: [
    { usbVendorId: 0x239a }, // Adafruit nRF52
    { usbVendorId: 0x303a }, // ESP32-S3
    { usbVendorId: 0x10c4 }, // CP210x on T-Beam and Heltec
    { usbVendorId: 0x1a86 }, // CH340
  ],
  bleFilters: { services: [SERVICE] },
}

// protobuf encoders, small and specific to what this driver sends -----------

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function encodeVarint(value: number): Uint8Array {
  const out: number[] = []
  let v = value
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v & 0x7f)
  return new Uint8Array(out)
}

function tag(field: number, wire: number): Uint8Array {
  return encodeVarint((field << 3) | wire)
}

function varintField(field: number, value: number): Uint8Array {
  return concat([tag(field, 0), encodeVarint(value)])
}

function lenField(field: number, bytes: Uint8Array): Uint8Array {
  return concat([tag(field, 2), encodeVarint(bytes.length), bytes])
}

function fixed32Field(field: number, value: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, value >>> 0, true)
  return concat([tag(field, 5), b])
}

function encodeTextToRadio(text: string, channel: number): Uint8Array {
  const payload = new TextEncoder().encode(text)
  const data = concat([varintField(1, PORTNUM_TEXT), lenField(2, payload)])
  const id = Math.floor(Math.random() * 0xffffffff) >>> 0
  const packet = concat([
    fixed32Field(2, BROADCAST),
    varintField(3, channel),
    lenField(4, data),
    fixed32Field(6, id),
  ])
  return lenField(1, packet)
}

function encodeWantConfig(nonce: number): Uint8Array {
  return varintField(3, nonce)
}

// field helpers -------------------------------------------------------------

function u32(f: DecodedField | undefined): number {
  if (!f) return 0
  if (f.fixed32 !== undefined) return f.fixed32 >>> 0
  if (f.varint !== undefined) return Number(f.varint & 0xffffffffn) >>> 0
  return 0
}

function toInt32(f: DecodedField | undefined): number | undefined {
  if (!f || f.fixed32 === undefined) return undefined
  const v = f.fixed32
  return v >= 0x80000000 ? v - 0x100000000 : v
}

function utf8(f: DecodedField | undefined): string {
  if (!f || !f.bytes) return ''
  return new TextDecoder().decode(f.bytes)
}

function hexId(num: number): string {
  return `!${(num >>> 0).toString(16).padStart(8, '0')}`
}

// link abstraction over the two transports ----------------------------------

interface MeshLink {
  sendToRadio(bytes: Uint8Array): Promise<void>
  beginReceive(onFromRadio: (payload: Uint8Array) => void, signal: AbortSignal): Promise<void>
  isOpen(): boolean
  close(): Promise<void>
}

class SerialMeshLink implements MeshLink {
  constructor(private port: SerialPortHandle) {}

  async sendToRadio(bytes: Uint8Array): Promise<void> {
    await this.port.write(encodeFrame(bytes))
  }

  async beginReceive(
    onFromRadio: (payload: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const framer = new StreamFramer()
    void this.port
      .read((chunk) => {
        for (const payload of framer.push(chunk)) onFromRadio(payload)
      }, signal)
      .catch(() => {
        // reader ends on abort or disconnect.
      })
  }

  isOpen(): boolean {
    return this.port.isOpen
  }

  async close(): Promise<void> {
    await this.port.disconnect()
  }
}

class BleMeshLink implements MeshLink {
  private onFromRadio: ((payload: Uint8Array) => void) | null = null
  private draining = false
  private stopped = false

  constructor(private link: BleLink) {}

  async sendToRadio(bytes: Uint8Array): Promise<void> {
    await this.link.write(SERVICE, CH_TORADIO, bytes, true)
  }

  async beginReceive(
    onFromRadio: (payload: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.onFromRadio = onFromRadio
    signal.addEventListener('abort', () => {
      this.stopped = true
    })
    await this.link.subscribe(SERVICE, CH_FROMNUM, () => {
      void this.drain()
    })
    void this.drain()
  }

  isOpen(): boolean {
    return this.link.isOpen
  }

  async close(): Promise<void> {
    this.stopped = true
    await this.link.disconnect()
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return
    this.draining = true
    try {
      while (!this.stopped) {
        const v = await this.link.read(SERVICE, CH_FROMRADIO)
        if (!v.length) break
        this.onFromRadio?.(v)
      }
    } catch {
      // link dropped mid-drain. health will notice.
    } finally {
      this.draining = false
    }
  }
}

class MeshtasticSession implements DeviceSession {
  private myNodeNum = 0

  constructor(
    private link: MeshLink,
    private ctx: DriverContext,
    private transport: TransportKind,
  ) {}

  getCapabilities(): Capability[] {
    return [CAPABILITIES.MESH_RX, CAPABILITIES.MESH_TX, CAPABILITIES.GNSS_FIX]
  }

  getInfo(): Record<string, string> {
    return { transport: this.transport === 'webble' ? 'web bluetooth' : 'web serial' }
  }

  async configure(): Promise<void> {
    // no runtime parameters, the radio holds its own configuration.
  }

  async start(mode: string): Promise<void> {
    if (mode !== 'listen') throw new Error(`meshtastic has no ${mode} mode`)
    await this.link.beginReceive((p) => this.onFromRadio(p), this.ctx.signal)
    const nonce = (Math.floor(Math.random() * 0xfffffffe) + 1) >>> 0
    await this.link.sendToRadio(encodeWantConfig(nonce))
    this.ctx.log('listening on the mesh')
  }

  async stop(): Promise<void> {
    // receive is driven by the abort signal, which the bus fires on stop.
  }

  async resetToSafeState(): Promise<void> {
    // the radio is receive only unless a send is issued. nothing to undo.
  }

  async close(): Promise<void> {
    await this.link.close()
  }

  async health(): Promise<boolean> {
    return this.link.isOpen()
  }

  /** Send a text message. Consequential, so it needs mesh tx armed. */
  async sendText(text: string, channel = 0): Promise<void> {
    if (!this.ctx.isArmed(CAPABILITIES.MESH_TX)) {
      throw new Error('mesh tx is not armed. arm mesh tx to send on the mesh.')
    }
    await this.link.sendToRadio(encodeTextToRadio(text, channel))
    this.ctx.log(`sent on channel ${channel}: ${text}`)
  }

  private onFromRadio(payload: Uint8Array): void {
    let msg: Map<number, DecodedField>
    try {
      msg = decodeMessage(payload)
    } catch {
      return // a partial or unexpected frame, drop it.
    }
    const myInfo = msg.get(3)
    if (myInfo?.bytes) this.onMyInfo(myInfo.bytes)
    const nodeInfo = msg.get(4)
    if (nodeInfo?.bytes) this.onNodeInfo(nodeInfo.bytes)
    const packet = msg.get(2)
    if (packet?.bytes) this.onPacket(packet.bytes)
  }

  private onMyInfo(bytes: Uint8Array): void {
    let m: Map<number, DecodedField>
    try {
      m = decodeMessage(bytes)
    } catch {
      return
    }
    const num = u32(m.get(1))
    this.myNodeNum = num
    this.ctx.setInfo({ node: hexId(num) })
    this.emitPacket(bytes, { myNodeNum: num }, `my node ${hexId(num)}`)
  }

  private onNodeInfo(bytes: Uint8Array): void {
    let m: Map<number, DecodedField>
    try {
      m = decodeMessage(bytes)
    } catch {
      return
    }
    const num = u32(m.get(1))
    const fields: Record<string, unknown> = { num }

    const userField = m.get(2)
    if (userField?.bytes) {
      const user = decodeMessage(userField.bytes)
      fields.longName = utf8(user.get(2))
      fields.shortName = utf8(user.get(3))
    }

    let battery: number | undefined
    const posField = m.get(3)
    if (posField?.bytes) {
      const pos = decodeMessage(posField.bytes)
      const latI = toInt32(pos.get(1))
      const lonI = toInt32(pos.get(2))
      if (latI !== undefined) fields.latitude = latI * 1e-7
      if (lonI !== undefined) fields.longitude = lonI * 1e-7
    }
    const metricsField = m.get(6)
    if (metricsField?.bytes) {
      const metrics = decodeMessage(metricsField.bytes)
      const batt = metrics.get(1)
      if (batt?.varint !== undefined) {
        battery = Number(batt.varint)
        fields.battery = battery
      }
    }

    const name = (fields.longName as string) || hexId(num)
    this.emitPacket(bytes, fields, `node ${name} ${hexId(num)}`)

    if (battery !== undefined) {
      const reading = {
        kind: 'reading' as const,
        name: 'battery',
        value: battery,
        unit: '%',
      }
      this.ctx.emit(reading)
    }
  }

  private onPacket(bytes: Uint8Array): void {
    let mp: Map<number, DecodedField>
    try {
      mp = decodeMessage(bytes)
    } catch {
      return
    }
    const decoded = mp.get(4)
    if (!decoded?.bytes) return // encrypted or non-data packet, skip.
    const from = u32(mp.get(1))
    const to = u32(mp.get(2))
    const channel = Number(mp.get(3)?.varint ?? 0n)

    const data = decodeMessage(decoded.bytes)
    const portnum = Number(data.get(1)?.varint ?? 0n)
    if (portnum !== PORTNUM_TEXT) return
    const text = utf8(data.get(2))

    const toLabel = to === BROADCAST ? 'all' : to === this.myNodeNum ? 'you' : hexId(to)
    this.emitPacket(
      bytes,
      { from, to, channel, text },
      `${hexId(from)} to ${toLabel}: ${text}`,
      channel,
    )
  }

  private emitPacket(
    bytes: Uint8Array,
    fields: Record<string, unknown>,
    summary: string,
    channel?: number,
  ): void {
    const rec = {
      kind: 'packet' as const,
      bytes,
      proto: 'meshtastic',
      channel,
      fields,
      summary,
    }
    this.ctx.emit(rec)
  }
}

function serialHandle(port: SerialPortHandle): DeviceHandle {
  const info = port.info
  const vid = info.usbVendorId?.toString(16) ?? '0'
  const pid = info.usbProductId?.toString(16) ?? '0'
  return {
    kind: 'meshtastic',
    transport: 'webserial',
    uid: `meshtastic-serial-${vid}-${pid}`,
    label: 'Meshtastic',
    raw: { kind: 'serial', port },
  }
}

export const meshtasticDriver: DeviceDriver = {
  descriptor,

  availableTransports(): TransportKind[] {
    const t: TransportKind[] = []
    if ('serial' in navigator) t.push('webserial')
    if ('bluetooth' in navigator) t.push('webble')
    return t
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
        link = await BleLink.request({ services: [SERVICE] })
      } catch {
        return null
      }
      return {
        kind: 'meshtastic',
        transport: 'webble',
        uid: `meshtastic-ble-${link.device.id}`,
        label: link.name,
        raw: { kind: 'ble', link },
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
    const raw = handle.raw as
      | { kind: 'serial'; port: SerialPortHandle }
      | { kind: 'ble'; link: BleLink }

    if (raw.kind === 'serial') {
      await raw.port.connect({ baudRate: SERIAL_BAUD })
      const session = new MeshtasticSession(new SerialMeshLink(raw.port), ctx, 'webserial')
      ctx.setInfo({ transport: 'web serial' })
      return session
    }

    await raw.link.connect()
    const session = new MeshtasticSession(new BleMeshLink(raw.link), ctx, 'webble')
    ctx.setInfo({ transport: 'web bluetooth' })
    return session
  },
}

export type { MeshtasticSession }

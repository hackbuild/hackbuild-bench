import { DS_TYPE, PIN_CAP } from 'conduyt-js'
import type { DatastreamDescriptor, HelloResp, ModuleDescriptor } from 'conduyt-js'
import { CAPABILITIES } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import { SpectrumAnalyzer } from '@/core/dsp/fft'
import type { DeviceDescriptor, ParamSpec } from '@/core/types'
import type {
  DeviceDriver,
  DeviceHandle,
  DeviceSession,
  DriverContext,
  TransmitFrameOptions,
  TxParams,
} from '../types'
import { boardProfile } from '../conduyt/profiles'

/**
 * Turns any driver into a simulated one.
 *
 * The simulator reads the real descriptor and produces the artifacts its
 * capabilities promise: a device that says it can observe a spectrum gets
 * carriers and a waterfall, one that says it captures packets gets frames in
 * its own protocol, one with a serial console gets a boot log. A new driver
 * gets a working simulator with no extra code, which is the point.
 */

export const SIM_PREFIX = 'sim:'

export function isSimKind(kind: string): boolean {
  return kind.startsWith(SIM_PREFIX)
}

/** The real device kind behind a simulated one. */
export function realKind(kind: string): string {
  return isSimKind(kind) ? kind.slice(SIM_PREFIX.length) : kind
}

// ---------------------------------------------------------------------------
// content per protocol, so a simulated ubertooth looks like bluetooth and a
// simulated meshtastic looks like a mesh
// ---------------------------------------------------------------------------

const BLE_NAMES = ['Govee_H5075', 'Pixel Buds', 'Tile', 'MiBand 7', 'ThermoPro', 'AirTag']
const MESH_NAMES = ['Sonoran Base', 'Papago', 'Four Peaks', 'South Mtn', 'Camelback']
const WIFI_NAMES = ['HomeNet', 'office-guest', 'PineappleTest', 'CenturyLink4821', 'ATT-2G']
const MESH_WORDS = [
  'anyone on this channel',
  'radio check, five by five',
  'heading up the trail now',
  'battery at forty percent',
  'see you at the meetup',
]
const BOOT_LOG = [
  ['note', 'auto baud locked at 115200'],
  ['rx', 'U-Boot 2021.10 (Mar 14 2024 - 09:22:41 +0000)'],
  ['rx', 'DRAM:  512 MiB'],
  ['rx', 'MMC:   sdhci@7824000: 0'],
  ['rx', 'Loading Environment from MMC... OK'],
  ['rx', 'Hit any key to stop autoboot:  3'],
  ['rx', 'Starting kernel ...'],
  ['rx', '[    0.000000] Booting Linux on physical CPU 0x0'],
  ['rx', '[    1.204512] usbcore: registered new interface driver usbfs'],
  ['rx', 'login: '],
] as const

function pick<T>(list: readonly T[], i: number): T {
  return list[i % list.length]
}

/**
 * A HELLO in the shape a real conduyt board sends, built off the esp32 devkit
 * profile so the pin capability bitmasks match a board that exists.
 */
function simHello(): HelloResp {
  const board = boardProfile('esp32dev')
  const pinCount = board?.pinCount ?? 20
  const analog = new Set(board?.analogPins ?? [])
  const pwm = new Set(board?.pwmPins ?? [])

  const pins = Array.from({ length: pinCount }, (_, pin) => {
    let capabilities = PIN_CAP.DIGITAL_IN | PIN_CAP.DIGITAL_OUT | PIN_CAP.INTERRUPT
    if (pwm.has(pin)) capabilities |= PIN_CAP.PWM_OUT
    if (analog.has(pin)) capabilities |= PIN_CAP.ANALOG_IN
    return { pin, capabilities }
  })

  return {
    firmwareName: 'SimBoard',
    firmwareVersion: [1, 0, 0],
    mcuId: new Uint8Array([0x24, 0x6f, 0x28, 0xaa, 0xbb, 0xcc, 0x00, 0x00]),
    otaCapable: true,
    pins,
    i2cBuses: board?.i2cBuses ?? 1,
    spiBuses: 2,
    uartCount: 3,
    maxPayload: 255,
    modules: [
      { moduleId: 1, name: 'servo', versionMajor: 1, versionMinor: 0, pins: [13] },
      { moduleId: 2, name: 'neopixel', versionMajor: 1, versionMinor: 0, pins: [5] },
      { moduleId: 3, name: 'dht', versionMajor: 1, versionMinor: 0, pins: [4] },
    ],
    datastreams: [
      {
        index: 0,
        name: 'temperature',
        type: DS_TYPE.FLOAT32,
        unit: 'C',
        writable: false,
        pinRef: 4,
        retain: true,
      },
      {
        index: 1,
        name: 'humidity',
        type: DS_TYPE.FLOAT32,
        unit: '%',
        writable: false,
        pinRef: 4,
        retain: true,
      },
    ],
  }
}

function randomMac(seed: number): string {
  const bytes: string[] = []
  for (let i = 0; i < 6; i++) {
    bytes.push((((seed * 31 + i * 7919) >>> 0) % 256).toString(16).padStart(2, '0'))
  }
  return bytes.join(':')
}

// ---------------------------------------------------------------------------

class SimulatedSession implements DeviceSession {
  private ctx: DriverContext
  private descriptor: DeviceDescriptor
  private analyzer = new SpectrumAnalyzer(2048)
  private params: Record<string, number> = {}
  private timers: Array<ReturnType<typeof setInterval>> = []
  private phase = 0
  private tick = 0
  private lineIndex = 0
  private pins = new Map<number, string>()
  private pinValues = new Map<number, number>()
  private simSubs = new Map<string, ReturnType<typeof setInterval>>()
  private hello: HelloResp | null = null
  private txOn = false

  constructor(descriptor: DeviceDescriptor, ctx: DriverContext) {
    this.descriptor = descriptor
    this.ctx = ctx
    for (const p of descriptor.params) this.params[p.key] = p.default
  }

  private has(cap: Capability): boolean {
    return this.descriptor.capabilities.includes(cap)
  }

  getCapabilities(): Capability[] {
    return this.descriptor.capabilities
  }

  getInfo(): Record<string, string> {
    const info: Record<string, string> = {
      mode: 'simulated',
      note: 'synthetic data, nothing is on the air or on a wire',
      serial: `sim-${this.descriptor.kind}`,
    }
    if (this.has(CAPABILITIES.GPIO_DRIVE)) {
      const hello = this.getHello()
      info['board id'] = 'esp32dev'
      info.firmware = hello ? `${hello.firmwareName} ${hello.firmwareVersion.join('.')}` : 'none'
      info.pins = String(hello?.pins.length ?? 0)
    }
    return info
  }

  async configure(params: Record<string, number>): Promise<void> {
    this.params = { ...this.params, ...params }
  }

  async start(mode: string): Promise<void> {
    if (this.timers.length) return
    this.ctx.log(`simulated ${mode} started`)

    if (this.has(CAPABILITIES.CAPTURE_IQ) || this.has(CAPABILITIES.OBSERVE_SPECTRUM)) {
      this.timers.push(setInterval(() => this.emitRadio(), 60))
    }
    if (this.has(CAPABILITIES.CAPTURE_PACKET) || this.has(CAPABILITIES.MESH_RX)) {
      this.timers.push(setInterval(() => this.emitPacket(), 900))
    }
    if (this.has(CAPABILITIES.NET_SURVEY)) {
      this.timers.push(setInterval(() => this.emitNetwork(), 1200))
    }
    if (this.has(CAPABILITIES.SERIAL_CONSOLE)) {
      this.timers.push(setInterval(() => this.emitLine(), 700))
    }
  }

  private emitRadio(): void {
    if (this.ctx.signal.aborted) return
    const rate = this.params.sampleRate ?? 2400000
    const centerHz = this.params.centerHz ?? this.tuningDefault()
    const n = 4096
    const iq = new Float32Array(n * 2)
    const step = (2 * Math.PI) / rate

    // three carriers that drift a little, so the waterfall has structure.
    const carriers = [
      { off: -0.28 * rate * 0.5, amp: 0.32, tone: 600 },
      { off: 0.07 * rate * 0.5, amp: 0.55, tone: 440 },
      { off: 0.51 * rate * 0.5, amp: 0.2, tone: 880 },
    ]

    for (let i = 0; i < n; i++) {
      let re = 0
      let im = 0
      const t = this.phase + i
      for (const c of carriers) {
        const mod = 0.5 + 0.5 * Math.sin(step * c.tone * t * 40)
        const angle = step * c.off * t
        re += Math.cos(angle) * c.amp * mod
        im += Math.sin(angle) * c.amp * mod
      }
      re += (Math.random() - 0.5) * 0.05
      im += (Math.random() - 0.5) * 0.05
      iq[i * 2] = re
      iq[i * 2 + 1] = im
    }
    this.phase += n

    if (this.has(CAPABILITIES.CAPTURE_IQ)) {
      this.ctx.emit({ kind: 'iq', samples: iq, centerHz, sampleRate: rate, dropped: 0 })
    }
    this.ctx.emit({
      kind: 'fft',
      bins: this.analyzer.process(iq).slice(),
      centerHz,
      sampleRate: rate,
    })
  }

  private tuningDefault(): number {
    const spec: ParamSpec | undefined = this.descriptor.params.find((p) => /hz$/i.test(p.key))
    return spec?.default ?? 100.3e6
  }

  private emitPacket(): void {
    if (this.ctx.signal.aborted) return
    const i = this.tick++
    const kind = realKind(this.descriptor.kind)

    if (this.has(CAPABILITIES.MESH_RX)) {
      const isText = i % 3 === 0
      this.ctx.emit({
        kind: 'packet',
        bytes: new Uint8Array([0x94, 0xc3, i & 0xff]),
        proto: 'meshtastic',
        rssi: -50 - (i % 40),
        fields: isText
          ? { type: 'text', from: pick(MESH_NAMES, i), text: pick(MESH_WORDS, i), channel: 0 }
          : {
              type: 'nodeinfo',
              nodeNum: 3000000000 + (i % 5),
              longName: pick(MESH_NAMES, i),
              shortName: pick(MESH_NAMES, i).slice(0, 4),
              latitude: (33.45 + (i % 5) * 0.01).toFixed(4),
              longitude: (-112.07 - (i % 5) * 0.01).toFixed(4),
              battery: 60 + (i % 40),
            },
        summary: isText ? `text from ${pick(MESH_NAMES, i)}` : `node ${pick(MESH_NAMES, i)}`,
      })
      return
    }

    if (kind === 'ubertooth') {
      const name = pick(BLE_NAMES, i)
      const mac = randomMac(i)
      this.ctx.emit({
        kind: 'packet',
        bytes: new Uint8Array([0xd6, 0xbe, 0x89, 0x8e, 0x40, 0x24, i & 0xff]),
        proto: 'ble',
        rssi: -45 - (i % 45),
        channel: 37 + (i % 3),
        fields: {
          address: mac,
          pdu: 'ADV_IND',
          name,
          flags: '0x06',
          ...(name === 'Govee_H5075' ? { temperature: '24.1C', humidity: '48%' } : {}),
        },
        summary: `ADV_IND  ${name}`,
      })
      return
    }

    const bytes = new Uint8Array(9)
    for (let b = 0; b < bytes.length; b++) bytes[b] = (i * 37 + b * 11) & 0xff
    this.ctx.emit({
      kind: 'packet',
      bytes,
      proto: 'ism',
      rssi: -40 - (i % 40),
      fields: { address: `0x${(0x8e41 + (i % 4)).toString(16)}`, bits: 24, modulation: 'ook' },
      summary: 'pt2262 style remote, 24 bit',
    })
  }

  private emitNetwork(): void {
    if (this.ctx.signal.aborted) return
    const i = this.tick++
    this.ctx.emit({
      kind: 'packet',
      bytes: new Uint8Array(0),
      proto: '802.11',
      rssi: -40 - (i % 50),
      fields: {
        ssid: pick(WIFI_NAMES, i),
        bssid: randomMac(i + 100),
        channel: [1, 6, 11, 36, 149][i % 5],
        encryption: i % 4 === 0 ? 'open' : 'WPA2',
      },
      summary: `beacon ${pick(WIFI_NAMES, i)}`,
    })
  }

  private emitLine(): void {
    if (this.ctx.signal.aborted) return
    if (this.lineIndex >= BOOT_LOG.length) return
    const [stream, text] = BOOT_LOG[this.lineIndex++]
    this.ctx.emit({ kind: 'line', text, stream: stream as 'rx' | 'tx' | 'note' })
  }

  // -- methods the panels reach for through bus.session() -------------------

  async write(text: string): Promise<void> {
    const clean = text.replace(/[\r\n]+$/, '')
    this.ctx.emit({ kind: 'line', text: clean, stream: 'tx' })
    this.ctx.emit({
      kind: 'line',
      text: `-sh: ${clean.split(' ')[0]}: not found`,
      stream: 'rx',
    })
  }

  async autoBaud(): Promise<number | null> {
    this.ctx.emit({ kind: 'line', text: 'trying 9600', stream: 'note' })
    this.ctx.emit({ kind: 'line', text: 'trying 115200, printable output', stream: 'note' })
    return 115200
  }

  // the conduyt surface, so the board panel can be worked without hardware.

  getHello(): HelloResp | null {
    if (!this.has(CAPABILITIES.GPIO_DRIVE)) return null
    if (!this.hello) this.hello = simHello()
    return this.hello
  }

  async setPinMode(pin: number, mode: string): Promise<void> {
    if (mode === 'output' || mode === 'pwm') {
      this.requireArmed(CAPABILITIES.GPIO_DRIVE, `set pin ${pin} to ${mode}`)
    }
    this.pins.set(pin, mode)
    this.ctx.log(`pin ${pin} mode ${mode}`)
  }

  async writePin(pin: number, value: number): Promise<void> {
    this.requireArmed(CAPABILITIES.GPIO_DRIVE, `write pin ${pin}`)
    this.pinValues.set(pin, value)
    this.ctx.emit({ kind: 'reading', name: `pin ${pin}`, value })
  }

  async readPin(pin: number): Promise<number> {
    const value = this.pinValues.get(pin) ?? (pin * 7 + this.tick) % 2
    this.ctx.emit({ kind: 'reading', name: `pin ${pin}`, value })
    return value
  }

  async analogRead(pin: number): Promise<number> {
    const value = Math.round(512 + 480 * Math.sin(Date.now() / 900 + pin))
    this.ctx.emit({ kind: 'reading', name: `pin ${pin}`, value, unit: 'counts' })
    return value
  }

  async scanI2c(): Promise<number[]> {
    return [0x1d, 0x3c, 0x48, 0x68]
  }

  async i2cRead(addr: number, count: number): Promise<Uint8Array> {
    const out = new Uint8Array(count)
    for (let i = 0; i < count; i++) out[i] = (addr * 13 + i * 29) & 0xff
    return out
  }

  async i2cWrite(addr: number, bytes: Uint8Array): Promise<void> {
    this.requireArmed(CAPABILITIES.BUS_DRIVE, `write to 0x${addr.toString(16)}`)
    this.ctx.log(`i2c wrote ${bytes.length} bytes to 0x${addr.toString(16)}`)
  }

  listModules(): ModuleDescriptor[] {
    return this.getHello()?.modules ?? []
  }

  async moduleCommand(name: string, cmd: number): Promise<Uint8Array> {
    this.requireArmed(CAPABILITIES.GPIO_DRIVE, `send command 0x${cmd.toString(16)} to ${name}`)
    this.ctx.log(`${name} took command 0x${cmd.toString(16)}`)
    return new Uint8Array(0)
  }

  listDatastreams(): DatastreamDescriptor[] {
    return this.getHello()?.datastreams ?? []
  }

  subscribeDatastream(name: string): () => void {
    const ds = this.listDatastreams().find((d) => d.name === name)
    return this.simSubscribe(`ds:${name}`, () => {
      this.ctx.emit({
        kind: 'reading',
        name,
        value: Number((20 + 8 * Math.sin(Date.now() / 4000 + name.length)).toFixed(2)),
        unit: ds?.unit || 'unit',
      })
    })
  }

  subscribePin(pin: number, analog = false): () => void {
    return this.simSubscribe(`pin:${pin}`, () => {
      const value = analog
        ? Math.round(512 + 480 * Math.sin(Date.now() / 900 + pin))
        : (Date.now() / 1000 + pin) % 2 < 1
          ? 1
          : 0
      this.ctx.emit(
        analog
          ? { kind: 'reading', name: `pin ${pin}`, value, unit: 'counts' }
          : { kind: 'reading', name: `pin ${pin}`, value },
      )
    })
  }

  async ping(): Promise<void> {
    this.ctx.log('pong, 0 ms, nothing left the browser')
  }

  async resetBoard(): Promise<void> {
    this.pins.clear()
    this.pinValues.clear()
    this.ctx.log('board reset, it comes back with every pin as an input')
  }

  private requireArmed(cap: Capability, action: string): void {
    if (this.ctx.isArmed(cap)) return
    const label = cap === CAPABILITIES.BUS_DRIVE ? 'bus drive' : 'gpio drive'
    throw new Error(`${label} is not armed. arm ${label} to ${action}.`)
  }

  private simSubscribe(key: string, emit: () => void): () => void {
    const running = this.simSubs.get(key)
    if (running) clearInterval(running)
    this.simSubs.set(key, setInterval(emit, 800))
    return () => {
      const timer = this.simSubs.get(key)
      if (timer) clearInterval(timer)
      this.simSubs.delete(key)
    }
  }

  async sendText(text: string): Promise<void> {
    if (!this.ctx.isArmed(CAPABILITIES.MESH_TX)) {
      throw new Error('arm mesh tx first, the button is in the bar above')
    }
    this.ctx.emit({
      kind: 'packet',
      bytes: new Uint8Array(0),
      proto: 'meshtastic',
      fields: { type: 'text', from: 'this node', text, channel: 0 },
      summary: 'sent',
    })
  }

  async replayFrame(bytes: Uint8Array): Promise<void> {
    if (!this.ctx.isArmed(CAPABILITIES.TRANSMIT_RF)) {
      throw new Error('arm rf transmit first, the button is in the bar above')
    }
    this.ctx.log(`simulated replay of ${bytes.length} bytes, nothing reached an antenna`)
  }

  // -- transmit --------------------------------------------------------------

  private requireTx(): void {
    if (!this.has(CAPABILITIES.TRANSMIT_RF)) {
      throw new Error('this simulated device does not transmit')
    }
    if (!this.ctx.isArmed(CAPABILITIES.TRANSMIT_RF)) {
      throw new Error('arm rf transmit first, the button is in the bar above')
    }
  }

  async setTxParams(params: TxParams): Promise<void> {
    this.requireTx()
    if (params.centerHz !== undefined) this.params.centerHz = params.centerHz
    if (params.sampleRate !== undefined) this.params.sampleRate = params.sampleRate
    if (params.txvga !== undefined) this.params.txvga = params.txvga
    if (params.amp !== undefined) this.params.amp = params.amp
  }

  async beginTransmit(): Promise<void> {
    this.requireTx()
    this.txOn = true
    this.ctx.log(
      `simulated transmit at ${((this.params.centerHz ?? 0) / 1e6).toFixed(3)} MHz, nothing reached an antenna`,
    )
  }

  /** Paced against the clock so a panel's progress bar behaves like the radio. */
  async transmitIq(samples: Float32Array, sampleRate: number): Promise<void> {
    this.requireTx()
    const seconds = samples.length / 2 / Math.max(1, sampleRate)
    await new Promise((resolve) => setTimeout(resolve, Math.min(2000, seconds * 1000)))
  }

  async transmitFrame(bytes: Uint8Array, opts: TransmitFrameOptions = {}): Promise<void> {
    this.requireTx()
    const keying = opts.mode ?? 'ook'
    const bitRate = opts.bitRate ?? 2000
    this.ctx.log(
      `simulated frame: ${bytes.length} bytes as ${keying} at ${bitRate}, nothing reached an antenna`,
    )
    await new Promise((resolve) => setTimeout(resolve, ((bytes.length * 8) / bitRate) * 1000))
  }

  async endTransmit(): Promise<void> {
    this.txOn = false
  }

  isTransmitting(): boolean {
    return this.txOn
  }

  // -- lifecycle -------------------------------------------------------------

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const t of this.simSubs.values()) clearInterval(t)
    this.simSubs.clear()
  }

  async resetToSafeState(): Promise<void> {
    await this.stop()
    this.pins.clear()
    this.pinValues.clear()
  }

  async close(): Promise<void> {
    await this.stop()
  }

  async health(): Promise<boolean> {
    return true
  }
}

/**
 * Wraps a real driver as a simulated one. The kind is prefixed so the bus can
 * tell them apart, and the capabilities are copied verbatim so exactly the
 * same tools mount against it.
 */
export function makeSimDriver(real: DeviceDriver): DeviceDriver {
  const descriptor: DeviceDescriptor = {
    ...real.descriptor,
    kind: `${SIM_PREFIX}${real.descriptor.kind}`,
    name: `${real.descriptor.name} (demo)`,
    blurb: real.descriptor.blurb,
    transports: ['sim'],
    accessFields: undefined,
  }

  return {
    descriptor,

    availableTransports: () => ['sim'],

    async requestAccess(): Promise<DeviceHandle | null> {
      return {
        kind: descriptor.kind,
        transport: 'sim',
        uid: descriptor.kind,
        label: descriptor.name,
        raw: null,
      }
    },

    async open(_handle: DeviceHandle, ctx: DriverContext): Promise<DeviceSession> {
      return new SimulatedSession(descriptor, ctx)
    },
  }
}

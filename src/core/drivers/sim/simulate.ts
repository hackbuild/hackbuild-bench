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
import { boardProfile, mcuProfile } from '../conduyt/profiles'

/**
 * Turns any driver into a simulated one.
 *
 * The simulator reads the real descriptor and produces the artifacts its
 * capabilities promise: a device that says it can observe a spectrum gets
 * carriers and a waterfall, one that says it captures packets gets frames in
 * its own protocol, one with a serial console gets a boot log. A new driver
 * gets a working simulator with no extra code.
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

// ---------------------------------------------------------------------------
// the synthetic band, so what a radio hears depends on where it is tuned
// ---------------------------------------------------------------------------

/**
 * The highest IQ rate this can fill in real time from the main thread. A block
 * is sized from the clock at this rate and stamped with it, so a chunk really
 * does hold the seconds of signal its sample rate claims, whatever rate the
 * device knob asks for.
 */
const SIM_IQ_RATE = 240000
const SIM_EMIT_MS = 20
/** How often a display gets a frame, slower than blocks arrive. */
const SIM_FFT_MS = 40
/** A throttled timer can wake late, and one block will not make up more. */
const SIM_MAX_BLOCK_MS = 250
/** Puts an empty window near -90 dB, far enough under a carrier to scan by. */
const SIM_NOISE_AMP = 8e-5
const SIM_FLOOR_DB = -95
/** Peak deviation, narrow enough to sit inside an nfm channel. */
const SIM_DEVIATION_HZ = 5000
/** Stations sit on this grid, so a channel reads the same on every visit. */
const SIM_STATION_HZ = 200000
/** Occupancy is clustered into blocks this wide, the way a real band is. */
const SIM_BLOCK_HZ = 2e6
/** Frequencies that always hold a station, so a device opens on a live one. */
const SIM_ALWAYS_ON = [100.3e6, 433.92e6]

const SIN_SIZE = 4096
const SIN_TABLE = new Float32Array(SIN_SIZE)
for (let i = 0; i < SIN_SIZE; i++) SIN_TABLE[i] = Math.sin((2 * Math.PI * i) / SIN_SIZE)

/** Phase in turns, kept in 0..1 by the caller so the index cannot overflow. */
function sinTurns(turns: number): number {
  return SIN_TABLE[(turns * SIN_SIZE) & (SIN_SIZE - 1)]
}

function hash01(a: number, b: number): number {
  let h = (Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39) >>> 0
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

interface SimStation {
  hz: number
  amp: number
  toneHz: number
}

/**
 * What sits on one grid slot at one moment. Occupancy comes from the frequency
 * alone, so a channel reads the same level every time the radio comes back to
 * it, and the keying gate is coarse in time so a call opens, runs for a few
 * seconds and ends rather than holding a scanner forever.
 */
function stationAt(hz: number, atMs: number): SimStation | null {
  const slot = Math.round(hz / SIM_STATION_HZ)
  const center = slot * SIM_STATION_HZ
  const forced = SIM_ALWAYS_ON.find((f) => Math.round(f / SIM_STATION_HZ) === slot)
  if (forced === undefined) {
    if (hash01(Math.floor(center / SIM_BLOCK_HZ), 7) < 0.55) return null
    if (hash01(slot, 11) < 0.62) return null
    if (hash01(slot, Math.floor(atMs / 3000) + 3) < 0.35) return null
  }
  return {
    hz: forced ?? center,
    amp: 0.18 + 0.4 * hash01(slot, 5),
    toneHz: 300 + Math.round(900 * hash01(slot, 9)),
  }
}

/** The stations inside a window, low to high. */
function stationsIn(lowHz: number, highHz: number, atMs: number): SimStation[] {
  const first = Math.ceil(lowHz / SIM_STATION_HZ)
  const last = Math.floor(highHz / SIM_STATION_HZ)
  const out: SimStation[] = []
  for (let slot = first; slot <= last; slot++) {
    const station = stationAt(slot * SIM_STATION_HZ, atMs)
    if (station) out.push(station)
  }
  return out
}

/** The board the simulator claims to be. Every reading has to scale to it. */
const SIM_BOARD_ID = 'esp32dev'
const SIM_ADC_MAX = (1 << (mcuProfile(boardProfile(SIM_BOARD_ID)?.mcu ?? '')?.adcBits ?? 10)) - 1

/**
 * A HELLO in the shape a real conduyt board sends, built off the esp32 devkit
 * profile so the pin capability bitmasks match a board that exists.
 */
function simHello(): HelloResp {
  const board = boardProfile(SIM_BOARD_ID)
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
  private mode = ''
  /** Carrier and tone phase per station, so a block joins the last one. */
  private phases = new Map<number, { carrier: number; tone: number }>()
  private lastBlockAt = 0
  private lastFftAt = 0
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
    if (this.has(CAPABILITIES.CAPTURE_IQ)) {
      info.synthesis = this.synthesisNote()
    }
    if (this.has(CAPABILITIES.GPIO_DRIVE)) {
      const hello = this.getHello()
      info['board id'] = SIM_BOARD_ID
      info.firmware = hello ? `${hello.firmwareName} ${hello.firmwareVersion.join('.')}` : 'none'
      info.pins = String(hello?.pins.length ?? 0)
    }
    return info
  }

  async configure(params: Record<string, number>): Promise<void> {
    this.params = { ...this.params, ...params }
    if (this.has(CAPABILITIES.CAPTURE_IQ)) this.ctx.setInfo({ synthesis: this.synthesisNote() })
  }

  /**
   * The rate the stream really carries. A spectrum span or a receiver window
   * reads off the chunk, so it will not match a sample rate knob set higher.
   */
  private synthesisNote(): string {
    const asked = this.params.sampleRate ?? SIM_IQ_RATE
    const at = `iq at ${SIM_IQ_RATE / 1000} ksps`
    if (asked <= SIM_IQ_RATE) return at
    return `${at}, the ${Math.round(asked / 1000)} ksps knob is not filled`
  }

  async start(mode: string): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.mode = mode
    this.lineIndex = 0
    this.lastBlockAt = 0
    this.ctx.log(`simulated ${mode} started`)

    if (this.has(CAPABILITIES.CAPTURE_IQ) || this.has(CAPABILITIES.OBSERVE_SPECTRUM)) {
      this.timers.push(
        this.bandRange()
          ? setInterval(() => this.emitBand(), SIM_FFT_MS)
          : setInterval(() => this.emitRadio(), SIM_EMIT_MS),
      )
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

  /**
   * One block of IQ, sized from the clock so the stream runs at the rate the
   * chunk reports. The stations in the window are frequency modulated, which
   * is what a demodulator downstream needs to produce a tone.
   */
  private emitRadio(): void {
    if (this.ctx.signal.aborted) return
    const rate = Math.min(this.params.sampleRate ?? SIM_IQ_RATE, SIM_IQ_RATE)
    const centerHz = this.params.centerHz ?? this.tuningDefault()
    const now = performance.now()
    const elapsed = this.lastBlockAt
      ? Math.min(now - this.lastBlockAt, SIM_MAX_BLOCK_MS)
      : SIM_EMIT_MS
    this.lastBlockAt = now
    const n = Math.max(1, Math.round((rate * elapsed) / 1000))
    const iq = new Float32Array(n * 2)
    const half = rate / 2

    for (const station of stationsIn(centerHz - half, centerHz + half, Date.now())) {
      const offset = station.hz - centerHz
      if (Math.abs(offset) >= half) continue
      const state = this.phaseOf(station.hz)
      const carrierStep = offset / rate
      const toneStep = station.toneHz / rate
      const devStep = SIM_DEVIATION_HZ / rate
      let carrier = state.carrier
      let tone = state.tone
      for (let i = 0; i < n; i++) {
        tone += toneStep
        if (tone >= 1) tone -= 1
        carrier += carrierStep + devStep * sinTurns(tone)
        carrier -= Math.floor(carrier)
        iq[i * 2] += station.amp * sinTurns(carrier + 0.25)
        iq[i * 2 + 1] += station.amp * sinTurns(carrier)
      }
      state.carrier = carrier
      state.tone = tone
    }
    for (let i = 0; i < n * 2; i++) iq[i] += (Math.random() - 0.5) * SIM_NOISE_AMP

    if (this.has(CAPABILITIES.CAPTURE_IQ)) {
      this.ctx.emit({ kind: 'iq', samples: iq, centerHz, sampleRate: rate, dropped: 0 })
    }
    if (now - this.lastFftAt >= SIM_FFT_MS) {
      this.lastFftAt = now
      this.ctx.emit({
        kind: 'fft',
        bins: this.analyzer.process(iq).slice(),
        centerHz,
        sampleRate: rate,
      })
    }
  }

  /**
   * A picture of a whole band rather than a window: what a sweep produces, and
   * the only spectrum a device with no IQ path has. The frame carries the
   * range it covers, so the readouts under the display match the band.
   */
  private emitBand(): void {
    if (this.ctx.signal.aborted) return
    const band = this.bandRange()
    if (!band) return
    const spanHz = band.highHz - band.lowHz
    const count = Math.max(64, Math.min(2048, Math.round(spanHz / 1e6)))
    const bins = new Float32Array(count).fill(SIM_FLOOR_DB)

    for (const station of stationsIn(band.lowHz, band.highHz, Date.now())) {
      const bin = Math.floor(((station.hz - band.lowHz) / spanHz) * count)
      if (bin < 0 || bin >= count) continue
      const db = 20 * Math.log10(station.amp)
      bins[bin] = Math.max(bins[bin], db)
      if (bin > 0) bins[bin - 1] = Math.max(bins[bin - 1], db - 12)
      if (bin < count - 1) bins[bin + 1] = Math.max(bins[bin + 1], db - 12)
    }
    for (let i = 0; i < count; i++) bins[i] += (Math.random() - 0.5) * 4

    this.ctx.emit({
      kind: 'fft',
      bins,
      centerHz: band.lowHz + spanHz / 2,
      sampleRate: spanHz,
    })
  }

  private phaseOf(hz: number): { carrier: number; tone: number } {
    // tuning around leaves phases behind for stations nothing is listening to.
    if (this.phases.size > 64) this.phases.clear()
    let state = this.phases.get(hz)
    if (!state) {
      state = { carrier: 0, tone: 0 }
      this.phases.set(hz, state)
    }
    return state
  }

  /** The tuning knob, in whatever unit the descriptor states it in. */
  private tuningParam(): ParamSpec | undefined {
    return this.descriptor.params.find((p) => /hz$/i.test(p.key) || /^m?hz$/i.test(p.unit ?? ''))
  }

  private tuningDefault(): number {
    const spec = this.tuningParam()
    if (!spec) return 100.3e6
    return spec.default * (/^mhz$/i.test(spec.unit ?? '') ? 1e6 : 1)
  }

  /**
   * The range a spectrum frame covers when it is a band rather than a window:
   * the requested sweep, or, for a device with no IQ path, the whole range its
   * tuning knob can reach. The sweep knobs move independently, so the high end
   * holds at least 1 MHz above the low one, matching the hardware driver.
   */
  private bandRange(): { lowHz: number; highHz: number } | null {
    if (!this.has(CAPABILITIES.OBSERVE_SPECTRUM)) return null
    const low = this.params.sweepLowHz
    const high = this.params.sweepHighHz
    if (this.mode === 'sweep' && low !== undefined && high !== undefined) {
      return { lowHz: low, highHz: Math.max(low + 1e6, high) }
    }
    if (this.has(CAPABILITIES.CAPTURE_IQ)) return null
    const spec = this.tuningParam()
    if (!spec) return null
    const scale = /^mhz$/i.test(spec.unit ?? '') ? 1e6 : 1
    return { lowHz: spec.min * scale, highHz: spec.max * scale }
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
      const mac = randomMac(i % BLE_NAMES.length)
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
        bssid: randomMac((i % WIFI_NAMES.length) + 100),
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
    const value = this.pinValues.get(pin) ?? this.digitalSample(pin)
    this.ctx.emit({ kind: 'reading', name: `pin ${pin}`, value })
    return value
  }

  /** An unwritten pin squares off on its own, offset per pin. */
  private digitalSample(pin: number): number {
    return Math.floor(Date.now() / 1500 + pin * 0.5) % 2
  }

  async analogRead(pin: number): Promise<number> {
    const value = this.analogSample(pin)
    this.ctx.emit({ kind: 'reading', name: `pin ${pin}`, value, unit: 'counts' })
    return value
  }

  /** Full scale is the board's own adc, so the panel's gauge reads right. */
  private analogSample(pin: number): number {
    return Math.round(SIM_ADC_MAX / 2 + SIM_ADC_MAX * 0.47 * Math.sin(Date.now() / 900 + pin))
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
      const value = analog ? this.analogSample(pin) : this.digitalSample(pin)
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

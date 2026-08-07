<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { PIN_CAP } from 'conduyt-js'
import type { HelloResp, PinCapability } from 'conduyt-js'
import { HbButton, HbCheckbox, HbIcon } from '@virgilvox/hackbuild-ui'
import type { IconName } from '@virgilvox/hackbuild-ui'
import ArmDialog from '@/components/bench/ArmDialog.vue'
import { fitCanvas, readTokens } from '@/components/instruments/canvas'
import type { ScreenTokens } from '@/components/instruments/canvas'
import { bus } from '@/core/bus/DeviceBus'
import { CAPABILITIES } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import type { ConduytPinMode, ConduytSession } from '@/core/drivers/conduyt'
import { boardProfile, browserFlashSummary, mcuProfile, pinLabel } from '@/core/drivers/conduyt/profiles'
import { formatClock, fromHex, toHex } from '@/core/format'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { useDevices } from '@/stores/devices'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const stream = useDeviceStream(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)

/**
 * Read off the node list rather than off the node computed. The list is
 * replaced on every bus event but the node object inside it is the same
 * reference, so a computed that returns the node never notifies anything
 * downstream and the arm state would stay stale here.
 */
function armedFor(cap: Capability): boolean {
  const found = devices.nodes.find((n) => n.id === props.deviceId)
  return found?.armed.includes(cap) ?? false
}

const armedGpio = computed(() => armedFor(CAPABILITIES.GPIO_DRIVE))
const armedBus = computed(() => armedFor(CAPABILITIES.BUS_DRIVE))

const PLAYGROUND = 'https://conduyt.io/playground'

/** Command bytes from the conduyt module wrappers. */
const SERVO_ATTACH = 0x01
const SERVO_WRITE = 0x02
const NEOPIXEL_BEGIN = 0x01
const NEOPIXEL_FILL = 0x04
const NEOPIXEL_SHOW = 0x05

/** Colours here are the payload sent to the strip, not chrome. */
const SWATCHES = [
  { name: 'red', rgb: [255, 0, 0] },
  { name: 'amber', rgb: [255, 120, 0] },
  { name: 'green', rgb: [0, 255, 80] },
  { name: 'cyan', rgb: [0, 200, 255] },
  { name: 'blue', rgb: [40, 60, 255] },
  { name: 'white', rgb: [255, 255, 255] },
  { name: 'off', rgb: [0, 0, 0] },
]

type WidgetType = 'switch' | 'momentary' | 'slider' | 'led' | 'gauge' | 'scope'

interface WidgetSpec {
  type: WidgetType
  label: string
  blurb: string
  icon: IconName
  kind: 'input' | 'output'
  mode: ConduytPinMode
  /** Bit in the pin capability mask a pin must carry to take this widget. */
  cap: number
  capName: string
  /** 0 means the widget only speaks when the user touches it. */
  pollMs: number
}

interface Widget {
  id: number
  type: WidgetType
  pin: number
  title: string
  value: number | null
  peak: number
}

interface StoredWidget {
  type: WidgetType
  pin: number
  title: string
  value: number
}

const SPECS: WidgetSpec[] = [
  {
    type: 'switch',
    label: 'switch',
    blurb: 'digital output',
    icon: 'power',
    kind: 'output',
    mode: 'output',
    cap: PIN_CAP.DIGITAL_OUT,
    capName: 'digital out',
    pollMs: 0,
  },
  {
    type: 'momentary',
    label: 'momentary',
    blurb: 'push button output',
    icon: 'bolt',
    kind: 'output',
    mode: 'output',
    cap: PIN_CAP.DIGITAL_OUT,
    capName: 'digital out',
    pollMs: 0,
  },
  {
    type: 'slider',
    label: 'slider',
    blurb: 'pwm output',
    icon: 'sliders',
    kind: 'output',
    mode: 'pwm',
    cap: PIN_CAP.PWM_OUT,
    capName: 'pwm out',
    pollMs: 0,
  },
  {
    type: 'led',
    label: 'led',
    blurb: 'digital input indicator',
    icon: 'lightbulb',
    kind: 'input',
    mode: 'input',
    cap: PIN_CAP.DIGITAL_IN,
    capName: 'digital in',
    pollMs: 200,
  },
  {
    type: 'gauge',
    label: 'gauge',
    blurb: 'analog input',
    icon: 'gauge',
    kind: 'input',
    mode: 'analog',
    cap: PIN_CAP.ANALOG_IN,
    capName: 'analog in',
    pollMs: 200,
  },
  {
    type: 'scope',
    label: 'scope',
    blurb: 'analog input over time',
    icon: 'wave-square',
    kind: 'input',
    mode: 'analog',
    cap: PIN_CAP.ANALOG_IN,
    capName: 'analog in',
    pollMs: 60,
  },
]

const SPEC_BY_TYPE = new Map<WidgetType, WidgetSpec>(SPECS.map((s) => [s.type, s]))

const SCOPE_LEN = 120
const PWM_MAX = 255
const STORE_PREFIX = 'hb.conduyt.dash.'

function specOf(type: WidgetType): WidgetSpec {
  const spec = SPEC_BY_TYPE.get(type)
  if (!spec) throw new Error(`unknown widget type ${type}`)
  return spec
}

const hello = ref<HelloResp | null>(null)
const widgets = ref<Widget[]>([])
const permissive = ref(false)
const error = ref<string | null>(null)
const armPrompt = ref<string | null>(null)
const arming = ref<Capability | null>(null)
const notes = ref<Array<{ at: number; text: string }>>([])
const root = ref<HTMLElement | null>(null)
const logEl = ref<HTMLElement | null>(null)

const scanning = ref(false)
const addresses = ref<number[]>([])
const servoAngle = reactive<Record<string, number>>({})
const command = reactive<Record<string, string>>({})
const payload = reactive<Record<string, string>>({})
const reply = reactive<Record<string, string>>({})
const watching = reactive<Record<string, boolean>>({})

const canvases = new Map<number, HTMLCanvasElement>()
const scopeBuf = new Map<number, number[]>()
const polls = new Map<number, { stop: boolean; timer: number | null; errored: boolean }>()
const streamStops = new Map<string, () => void>()
const pendingPwm = new Map<number, number>()
const inflightPwm = new Set<number>()
/** Pin plus mode already sent, so a slider drag does not resend PIN_MODE. */
const modeApplied = new Set<string>()

let nextId = 1
let tokens: ScreenTokens | null = null

function session(): ConduytSession | undefined {
  return bus.session<ConduytSession>(props.deviceId)
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function note(text: string): void {
  notes.value = [...notes.value, { at: Date.now(), text }].slice(-200)
}

const lines = computed(() => {
  const fromDevice = devices.logs
    .filter((l) => l.deviceId === props.deviceId)
    .map((l) => ({ at: l.at, text: l.message }))
  return [...fromDevice, ...notes.value].sort((a, b) => a.at - b.at).slice(-200)
})

const profile = computed(() => boardProfile(node.value?.info['board id'] ?? ''))
const mcu = computed(() => (profile.value ? mcuProfile(profile.value.mcu) : null))
const mcuId = computed(() => (hello.value ? toHex(hello.value.mcuId, '') : ''))

/** Full scale of analogRead. Unknown boards get the 10 bit arduino default. */
const adcMax = computed(() => (mcu.value ? (1 << mcu.value.adcBits) - 1 : 1023))
const adcSource = computed(() =>
  mcu.value ? `${mcu.value.adcBits} bit adc on ${mcu.value.name}` : 'board not identified, 10 bit assumed',
)

const firmware = computed(() =>
  hello.value ? `${hello.value.firmwareName} ${hello.value.firmwareVersion.join('.')}` : 'none',
)
const modules = computed(() => hello.value?.modules ?? [])
const datastreams = computed(() => hello.value?.datastreams ?? [])
const hasI2c = computed(() => (hello.value?.i2cBuses ?? 0) > 0)

const storeKey = computed(() => (mcuId.value ? STORE_PREFIX + mcuId.value : ''))

// -- pins -------------------------------------------------------------------

function pinName(pin: number): string {
  const label = pinLabel(profile.value, pin)
  return label === `pin ${pin}` ? label : `${label} (${pin})`
}

/**
 * Pins that will take this widget. Strict mode trusts the capability bitmask
 * the firmware sent. Permissive offers every pin, for boards that under
 * declare. The bound pin is always in the list so the select can render it.
 */
function compatPins(cap: number, include?: number): PinCapability[] {
  const all = hello.value?.pins ?? []
  if (permissive.value) return all
  const strict = all.filter((p) => (p.capabilities & cap) !== 0)
  if (include !== undefined && !strict.some((p) => p.pin === include)) {
    const extra = all.find((p) => p.pin === include)
    if (extra) return [...strict, extra]
  }
  return strict
}

function addTitle(spec: WidgetSpec): string {
  const count = compatPins(spec.cap).length
  if (!count) {
    return `no pin on this board reports ${spec.capName}. tick permissive to bind one anyway.`
  }
  return `${spec.blurb}, ${count} pin${count === 1 ? '' : 's'} to pick from`
}

function canAdd(spec: WidgetSpec): boolean {
  return compatPins(spec.cap).length > 0
}

// -- widget lifecycle -------------------------------------------------------

function makeWidget(type: WidgetType, pin: number, title: string, value: number): Widget {
  const spec = specOf(type)
  return {
    id: nextId++,
    type,
    pin,
    title: title || spec.label,
    value: spec.kind === 'output' ? value : null,
    peak: 0,
  }
}

function addWidget(type: WidgetType): void {
  const spec = specOf(type)
  const pin = compatPins(spec.cap)[0]?.pin
  if (pin === undefined) {
    error.value = `no pin reports ${spec.capName}, so a ${spec.label} has nothing to bind to`
    return
  }
  const widget = makeWidget(type, pin, spec.label, 0)
  widgets.value = [...widgets.value, widget]
  note(`added ${spec.label} on ${pinName(pin)}`)
  save()
  void activate(widget)
}

function removeWidget(id: number): void {
  const widget = widgets.value.find((w) => w.id === id)
  stopPoll(id)
  canvases.delete(id)
  scopeBuf.delete(id)
  pendingPwm.delete(id)
  inflightPwm.delete(id)
  widgets.value = widgets.value.filter((w) => w.id !== id)
  if (widget) note(`removed ${widget.title}`)
  save()
}

function clearAll(): void {
  for (const w of [...widgets.value]) removeWidget(w.id)
}

function onPinChange(widget: Widget): void {
  scopeBuf.delete(widget.id)
  widget.peak = 0
  widget.value = specOf(widget.type).kind === 'output' ? 0 : null
  note(`${widget.title} moved to ${pinName(widget.pin)}`)
  save()
  void activate(widget)
}

/** Puts the pin in the widget's mode and starts its poll where it reads. */
async function activate(widget: Widget): Promise<void> {
  const spec = specOf(widget.type)
  stopPoll(widget.id)
  const s = session()
  if (!s) return
  if (spec.kind === 'output' && !armedGpio.value) return
  try {
    await ensureMode(s, widget)
  } catch (err) {
    fail(widget, err)
    return
  }
  if (spec.kind === 'input') startPoll(widget)
}

async function ensureMode(s: ConduytSession, widget: Widget): Promise<void> {
  const spec = specOf(widget.type)
  const key = `${widget.pin}:${spec.mode}`
  if (modeApplied.has(key)) return
  await s.setPinMode(widget.pin, spec.mode)
  for (const other of [...modeApplied]) {
    if (other.startsWith(`${widget.pin}:`)) modeApplied.delete(other)
  }
  modeApplied.add(key)
}

function fail(widget: Widget, err: unknown): void {
  const text = `${widget.title} on ${pinName(widget.pin)}: ${message(err)}`
  error.value = text
  note(text)
}

// -- arming -----------------------------------------------------------------

/** True when the write can go out. Otherwise the inline prompt is raised. */
function requireArm(action: string): boolean {
  if (armedGpio.value) return true
  armPrompt.value = `${action} puts current on the pin, so gpio drive has to be armed first. reads keep working either way.`
  return false
}

function openArm(): void {
  arming.value = CAPABILITIES.GPIO_DRIVE
}

// -- output widgets ---------------------------------------------------------

async function toggleSwitch(widget: Widget): Promise<void> {
  if (!requireArm(`writing ${pinName(widget.pin)}`)) return
  const s = session()
  if (!s) {
    error.value = 'this device is no longer attached'
    return
  }
  const next = widget.value ? 0 : 1
  try {
    await ensureMode(s, widget)
    await s.writePin(widget.pin, next)
    widget.value = next
    note(`${widget.title} ${next ? 'high' : 'low'}`)
    save()
  } catch (err) {
    fail(widget, err)
  }
}

async function pressDown(widget: Widget): Promise<void> {
  if (widget.value === 1) return
  if (!requireArm(`holding ${pinName(widget.pin)} high`)) return
  const s = session()
  if (!s) {
    error.value = 'this device is no longer attached'
    return
  }
  widget.value = 1
  try {
    await ensureMode(s, widget)
    await s.writePin(widget.pin, 1)
  } catch (err) {
    widget.value = 0
    fail(widget, err)
  }
}

async function pressUp(widget: Widget): Promise<void> {
  if (widget.value !== 1) return
  // the release lands even when the link died mid press, so the card cannot
  // stay stuck showing a held button.
  widget.value = 0
  const s = session()
  if (!s) return
  try {
    await s.writePin(widget.pin, 0)
  } catch (err) {
    fail(widget, err)
  }
}

function onSlider(widget: Widget, raw: string): void {
  const value = Math.max(0, Math.min(PWM_MAX, Number.parseInt(raw, 10) || 0))
  widget.value = value
  if (!requireArm(`driving ${pinName(widget.pin)} with pwm`)) return
  pendingPwm.set(widget.id, value)
  void flushSlider(widget)
}

/**
 * One pwm write in flight per widget. A drag produces values faster than the
 * link acknowledges them, so the newest value wins and the rest are dropped.
 */
async function flushSlider(widget: Widget): Promise<void> {
  if (inflightPwm.has(widget.id)) return
  const value = pendingPwm.get(widget.id)
  if (value === undefined) return
  pendingPwm.delete(widget.id)
  inflightPwm.add(widget.id)
  const s = session()
  try {
    if (s) {
      await ensureMode(s, widget)
      await s.writePin(widget.pin, value)
    }
  } catch (err) {
    fail(widget, err)
    pendingPwm.delete(widget.id)
  } finally {
    inflightPwm.delete(widget.id)
    if (pendingPwm.has(widget.id)) void flushSlider(widget)
  }
}

// -- input widgets ----------------------------------------------------------

function startPoll(widget: Widget): void {
  const spec = specOf(widget.type)
  if (spec.pollMs <= 0) return
  stopPoll(widget.id)
  const loop = { stop: false, timer: null as number | null, errored: false }
  polls.set(widget.id, loop)

  const tick = async (): Promise<void> => {
    if (loop.stop) return
    const s = session()
    if (s) {
      try {
        const value = spec.mode === 'analog' ? await s.analogRead(widget.pin) : await s.readPin(widget.pin)
        loop.errored = false
        applyInput(widget, value)
      } catch (err) {
        // one line per failure run, so a disconnected board does not flood.
        if (!loop.errored) {
          loop.errored = true
          note(`${widget.title} on ${pinName(widget.pin)}: ${message(err)}`)
        }
      }
    }
    if (!loop.stop) loop.timer = window.setTimeout(() => void tick(), spec.pollMs)
  }

  void tick()
}

function stopPoll(id: number): void {
  const loop = polls.get(id)
  if (!loop) return
  loop.stop = true
  if (loop.timer !== null) window.clearTimeout(loop.timer)
  polls.delete(id)
}

function applyInput(widget: Widget, value: number): void {
  widget.value = value
  if (value > widget.peak) widget.peak = value
  if (widget.type !== 'scope') return
  const buf = scopeBuf.get(widget.id) ?? []
  buf.push(value)
  if (buf.length > SCOPE_LEN) buf.shift()
  scopeBuf.set(widget.id, buf)
  drawScope(widget)
}

function bindCanvas(id: number, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLCanvasElement) canvases.set(id, el)
  else canvases.delete(id)
}

function drawScope(widget: Widget): void {
  const el = canvases.get(widget.id)
  if (!el || !tokens) return
  const screen = fitCanvas(el, true)
  if (!screen) return
  const { ctx, w: width, h: height } = screen

  ctx.fillStyle = tokens.screen
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.strokeStyle = tokens.dim
  ctx.lineWidth = 1
  for (let y = height / 3; y < height - 1; y += height / 3) {
    const line = Math.round(y) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, line)
    ctx.lineTo(width, line)
    ctx.stroke()
  }
  ctx.restore()

  const buf = scopeBuf.get(widget.id) ?? []
  if (buf.length < 2) return
  const full = Math.max(1, adcMax.value)
  const step = width / (SCOPE_LEN - 1)
  ctx.strokeStyle = tokens.slime
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = 0; i < buf.length; i++) {
    const x = i * step
    const y = height - 2 - Math.min(1, buf[i] / full) * (height - 4)
    if (i) ctx.lineTo(x, y)
    else ctx.moveTo(x, y)
  }
  ctx.stroke()
}

// -- readouts ---------------------------------------------------------------

function valueOf(widget: Widget): string {
  if (widget.value === null) return '-'
  if (widget.type === 'switch' || widget.type === 'momentary' || widget.type === 'led') {
    return widget.value ? 'high' : 'low'
  }
  return String(widget.value)
}

function gaugePct(value: number | null): number {
  if (value === null) return 0
  return Math.max(0, Math.min(100, (value / Math.max(1, adcMax.value)) * 100))
}

function readingOf(name: string): string {
  const r = stream.readings.value[name]
  if (!r) return '-'
  return r.unit ? `${r.value} ${r.unit}` : String(r.value)
}

// -- storage ----------------------------------------------------------------

function save(): void {
  if (!storeKey.value) return
  const stored: StoredWidget[] = widgets.value.map((w) => ({
    type: w.type,
    pin: w.pin,
    title: w.title,
    value: w.type === 'slider' ? (w.value ?? 0) : 0,
  }))
  try {
    localStorage.setItem(storeKey.value, JSON.stringify({ widgets: stored }))
  } catch {
    // a blocked or full store costs the saved layout only. the session runs on.
  }
}

function load(): void {
  if (!storeKey.value) return
  let raw: string | null = null
  try {
    raw = localStorage.getItem(storeKey.value)
  } catch {
    return
  }
  if (!raw) return

  let parsed: { widgets?: StoredWidget[] }
  try {
    parsed = JSON.parse(raw) as { widgets?: StoredWidget[] }
  } catch {
    return
  }

  const present = new Set((hello.value?.pins ?? []).map((p) => p.pin))
  const restored: Widget[] = []
  let dropped = 0
  for (const stored of parsed.widgets ?? []) {
    if (!SPEC_BY_TYPE.has(stored.type)) continue
    if (!present.has(stored.pin)) {
      dropped++
      continue
    }
    restored.push(makeWidget(stored.type, stored.pin, stored.title, stored.value))
  }
  widgets.value = restored
  if (restored.length) note(`restored ${restored.length} widgets saved for this board`)
  if (dropped) note(`dropped ${dropped} widgets bound to pins this board does not report`)
}

// -- board sections ---------------------------------------------------------

function guard(run: (s: ConduytSession) => Promise<unknown>): void {
  error.value = null
  const s = session()
  if (!s) {
    error.value = 'this device is no longer attached'
    return
  }
  void run(s).catch((err: unknown) => {
    error.value = message(err)
    note(message(err))
  })
}

function scan(): void {
  scanning.value = true
  guard(async (s) => {
    try {
      addresses.value = await s.scanI2c()
    } finally {
      scanning.value = false
    }
  })
}

function toggleWatchStream(name: string): void {
  const key = `ds:${name}`
  const stop = streamStops.get(key)
  if (stop) {
    stop()
    streamStops.delete(key)
    watching[key] = false
    return
  }
  guard(async (s) => {
    streamStops.set(key, s.subscribeDatastream(name))
    watching[key] = true
  })
}

/** Keeps the swatch label readable against the colour it sends. */
function swatchStyle(rgb: number[]): Record<string, string> {
  const [r, g, b] = rgb
  const light = 0.299 * r + 0.587 * g + 0.114 * b > 150
  return {
    background: `rgb(${r},${g},${b})`,
    color: light ? 'var(--hb-ink)' : 'var(--hb-paper)',
  }
}

function moveServo(name: string): void {
  if (!requireArm(`moving ${name}`)) return
  const angle = Math.max(0, Math.min(180, Math.round(servoAngle[name] ?? 90)))
  guard((s) => s.moduleCommand(name, SERVO_WRITE, new Uint8Array([angle])))
}

function attachServo(name: string, pin: number): void {
  if (!requireArm(`attaching ${name}`)) return
  // pin, then min and max pulse width in microseconds, little endian.
  const data = new Uint8Array([pin, 544 & 0xff, 544 >> 8, 2400 & 0xff, 2400 >> 8])
  guard((s) => s.moduleCommand(name, SERVO_ATTACH, data))
}

function fillPixels(name: string, rgb: number[]): void {
  if (!requireArm(`lighting ${name}`)) return
  guard(async (s) => {
    await s.moduleCommand(name, NEOPIXEL_FILL, new Uint8Array(rgb))
    await s.moduleCommand(name, NEOPIXEL_SHOW)
  })
}

function beginPixels(name: string, pin: number): void {
  if (!requireArm(`starting ${name}`)) return
  // pin, count as uint16 little endian, then strip type 0 for grb at 800 khz.
  const data = new Uint8Array([pin, 8, 0, 0])
  guard((s) => s.moduleCommand(name, NEOPIXEL_BEGIN, data))
}

function sendCommand(name: string): void {
  const cmd = Number.parseInt(command[name] ?? '', 16)
  if (!Number.isFinite(cmd)) {
    error.value = `enter the command byte for ${name} in hex, such as 02`
    return
  }
  if (!requireArm(`sending 0x${cmd.toString(16)} to ${name}`)) return
  guard(async (s) => {
    const answer = await s.moduleCommand(name, cmd, fromHex(payload[name] ?? ''))
    reply[name] = answer.length ? toHex(answer) : 'acknowledged, no data back'
  })
}

function ping(): void {
  guard((s) => s.ping())
}

function resetBoard(): void {
  modeApplied.clear()
  guard((s) => s.resetBoard())
}

// -- wiring -----------------------------------------------------------------

watch(permissive, (on) => note(`permissive ${on ? 'on, every pin is offered' : 'off, capability bitmask decides'}`))

watch(armedGpio, (on) => {
  if (!on) {
    modeApplied.clear()
    return
  }
  armPrompt.value = null
  for (const w of widgets.value) {
    if (specOf(w.type).kind === 'output') void activate(w)
  }
})

watch(
  () => lines.value.length,
  () => {
    void nextTick(() => {
      if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
    })
  },
)

onMounted(() => {
  hello.value = session()?.getHello() ?? null
  if (root.value) tokens = readTokens(root.value)
  for (const m of hello.value?.modules ?? []) {
    servoAngle[m.name] = 90
    command[m.name] = ''
    payload[m.name] = ''
  }
  load()
  for (const w of widgets.value) void activate(w)
})

onBeforeUnmount(() => {
  for (const id of [...polls.keys()]) stopPoll(id)
  for (const stop of streamStops.values()) stop()
  streamStops.clear()
  canvases.clear()
  scopeBuf.clear()
})
</script>

<template>
  <div ref="root">
    <div v-if="!hello" class="bn-banner is-err">
      <HbIcon name="warning" />
      <span>
        this board never answered hello, so there is nothing here to drive. reconnect it, or flash
        conduyt from the playground.
      </span>
    </div>

    <template v-else>
      <div v-if="armPrompt" class="bn-banner" role="alert">
        <HbIcon name="warning" />
        <span>{{ armPrompt }}</span>
        <HbButton size="sm" variant="danger" @click="openArm">
          <template #icon><HbIcon name="bolt" /></template>
          arm gpio drive
        </HbButton>
        <HbButton size="sm" @click="armPrompt = null">dismiss</HbButton>
      </div>

      <div v-else-if="!armedGpio" class="bn-banner is-warn">
        <HbIcon name="warning" />
        <span>
          reads are live. switches, buttons, sliders, modules, and i2c writes stay off until you arm
          gpio drive, since an output fighting something already driving the line damages both.
        </span>
      </div>

      <div v-if="error" class="bn-banner is-err" role="alert">
        <HbIcon name="warning" />
        <span>{{ error }}</span>
      </div>

      <div class="bn-meta">
        <div>
          <div class="bn-k">firmware</div>
          <div class="bn-v">{{ firmware }}</div>
        </div>
        <div>
          <div class="bn-k">board</div>
          <div class="bn-v">{{ profile?.name ?? 'not identified' }}</div>
        </div>
        <div>
          <div class="bn-k">pins</div>
          <div class="bn-v">{{ hello.pins.length }}</div>
        </div>
        <div>
          <div class="bn-k">i2c</div>
          <div class="bn-v">{{ hello.i2cBuses }}</div>
        </div>
        <div>
          <div class="bn-k">spi</div>
          <div class="bn-v">{{ hello.spiBuses }}</div>
        </div>
        <div>
          <div class="bn-k">widgets</div>
          <div class="bn-v is-pink">{{ widgets.length }}</div>
        </div>
        <div>
          <div class="bn-k">mcu id</div>
          <div class="bn-v">{{ mcuId }}</div>
        </div>
      </div>

      <div class="bn-addbar">
        <span class="bn-addlab">add widget</span>
        <button
          v-for="s in SPECS"
          :key="s.type"
          type="button"
          class="bn-tinyact"
          :disabled="!canAdd(s)"
          :title="addTitle(s)"
          @click="addWidget(s.type)"
        >
          <HbIcon :name="s.icon" /> {{ s.label }}
        </button>
        <span class="bn-push"></span>
        <HbCheckbox v-model="permissive">permissive</HbCheckbox>
        <button
          type="button"
          class="bn-tinyact"
          :disabled="!widgets.length"
          title="remove every widget from this board's dashboard"
          @click="clearAll"
        >
          clear all
        </button>
      </div>

      <p class="bn-note" style="margin-top: 0">
        permissive binds a widget to any pin even when the firmware never declared the capability.
        an under declared board takes it; a pin that genuinely cannot do the job answers
        pin_mode_unsupported and the card says so.
      </p>

      <div v-if="widgets.length" class="bn-wgrid" style="margin-top: 12px">
        <div v-for="w in widgets" :key="w.id" class="bn-wcard" :class="{ 'is-live': !!w.value }">
          <div class="bn-wh">
            <span class="bn-wkind">{{ specOf(w.type).label }}</span>
            <button
              type="button"
              class="bn-wx"
              :aria-label="`remove ${w.title}`"
              @click="removeWidget(w.id)"
            >
              remove
            </button>
          </div>

          <input
            v-model="w.title"
            class="bn-wtitle"
            type="text"
            maxlength="40"
            :aria-label="`name for widget on ${pinName(w.pin)}`"
            @change="save"
          />

          <div class="bn-wpin">
            <label :for="`pin-${w.id}`">pin</label>
            <select
              :id="`pin-${w.id}`"
              v-model.number="w.pin"
              @change="onPinChange(w)"
            >
              <option
                v-for="p in compatPins(specOf(w.type).cap, w.pin)"
                :key="p.pin"
                :value="p.pin"
              >
                {{ pinName(p.pin) }}
              </option>
            </select>
          </div>

          <div class="bn-wbody">
            <button
              v-if="w.type === 'switch'"
              type="button"
              class="bn-wsw"
              role="switch"
              :class="{ 'is-on': !!w.value }"
              :aria-checked="w.value ? 'true' : 'false'"
              :aria-label="`${w.title} output`"
              @click="toggleSwitch(w)"
            >
              <i></i>
              <span class="is-lo">low</span>
              <span class="is-hi">high</span>
            </button>

            <button
              v-else-if="w.type === 'momentary'"
              type="button"
              class="bn-wpress"
              :class="{ 'is-down': w.value === 1 }"
              :aria-pressed="w.value === 1 ? 'true' : 'false'"
              @pointerdown.prevent="pressDown(w)"
              @pointerup="pressUp(w)"
              @pointerleave="pressUp(w)"
              @pointercancel="pressUp(w)"
              @keydown.space.prevent="pressDown(w)"
              @keydown.enter.prevent="pressDown(w)"
              @keyup.space="pressUp(w)"
              @keyup.enter="pressUp(w)"
            >
              hold
            </button>

            <div v-else-if="w.type === 'slider'" class="bn-wslide">
              <div class="bn-wnum" style="text-align: center">{{ w.value ?? 0 }}</div>
              <input
                type="range"
                min="0"
                :max="PWM_MAX"
                step="1"
                :value="w.value ?? 0"
                :aria-label="`${w.title} duty`"
                @input="onSlider(w, ($event.target as HTMLInputElement).value)"
              />
              <div class="bn-wscale">
                <span>0</span><span>128</span><span>{{ PWM_MAX }}</span>
              </div>
            </div>

            <div
              v-else-if="w.type === 'led'"
              class="bn-wled"
              :class="{ 'is-on': !!w.value }"
              role="img"
              :aria-label="`${w.title} reads ${valueOf(w)}`"
            ></div>

            <template v-else-if="w.type === 'gauge'">
              <div class="bn-wnum">{{ w.value ?? '-' }}</div>
              <div class="bn-wbar">
                <i :style="{ width: gaugePct(w.value) + '%' }"></i>
              </div>
              <div class="bn-wread">
                <span>full scale <b>{{ adcMax }}</b></span>
                <span>peak <b>{{ w.peak }}</b></span>
              </div>
            </template>

            <template v-else>
              <div class="bn-void bn-wscope">
                <canvas
                  :ref="(el) => bindCanvas(w.id, el)"
                  role="img"
                  :aria-label="`${w.title} trace`"
                ></canvas>
              </div>
              <div class="bn-wread">
                <span>value <b>{{ w.value ?? '-' }}</b></span>
                <span>peak <b>{{ w.peak }}</b></span>
              </div>
            </template>
          </div>

          <div class="bn-wfoot">
            <span>{{ specOf(w.type).mode }}</span>
            <b>{{ valueOf(w) }}</b>
          </div>
        </div>
      </div>

      <div v-else class="bn-empty" style="margin-top: 12px">
        <h2>no widgets yet</h2>
        <p>
          add the controls you want from the bar above. each one binds to a single pin, and the pin
          list only offers pins whose capability bitmask matches. the layout is saved against this
          board's mcu id, so it comes back next time.
        </p>
      </div>

      <div class="bn-subhead" style="margin-top: 14px">
        console
        <span class="bn-aside">what the board and this panel did, newest at the bottom</span>
      </div>
      <div ref="logEl" class="bn-term" style="height: 150px">
        <div v-for="(l, i) in lines" :key="i">
          <span class="is-dim">{{ formatClock(l.at) }}</span>
          {{ ' ' + l.text }}
        </div>
        <div v-if="!lines.length" class="is-dim">nothing yet</div>
      </div>

      <div class="bn-knobs">
        <div class="bn-knob">
          <span class="bn-klabel">link</span>
          <HbButton size="sm" @click="ping">
            <template #icon><HbIcon name="bolt" /></template>
            ping
          </HbButton>
        </div>
        <div class="bn-knob">
          <span class="bn-klabel">&nbsp;</span>
          <HbButton size="sm" @click="resetBoard">
            <template #icon><HbIcon name="refresh" /></template>
            reset board
          </HbButton>
        </div>
      </div>

      <div class="bn-modules">
        <div class="bn-module">
          <div class="bn-mh">i2c</div>
          <div class="bn-mb">
            <p v-if="!hasI2c" class="bn-note" style="margin-top: 0">
              the board reported no i2c bus, so there is nothing to scan.
            </p>
            <template v-else>
              <HbButton size="sm" :loading="scanning" @click="scan">scan bus 0</HbButton>
              <div class="bn-fcaps">
                <span v-for="a in addresses" :key="a" class="bn-chipx is-pink">
                  0x{{ a.toString(16).padStart(2, '0') }}
                </span>
                <span v-if="!addresses.length" class="bn-chipx">nothing found yet</span>
              </div>
              <p class="bn-note">
                the scan reads one byte from every address from 0x08 to 0x77. writing to a device
                needs bus drive armed, which is {{ armedBus ? 'on' : 'off' }}.
              </p>
            </template>
          </div>
        </div>

        <div class="bn-module">
          <div class="bn-mh">datastreams</div>
          <div class="bn-mb">
            <p v-if="!datastreams.length" class="bn-note" style="margin-top: 0">
              the board declared no datastreams. they are named values the firmware publishes, and
              they show up here once the sketch registers one.
            </p>
            <template v-else>
              <div v-for="d in datastreams" :key="d.name" class="bn-fcaps">
                <span class="bn-chipx">{{ d.name }}</span>
                <span class="bn-val">{{ readingOf(d.name) }}</span>
                <button
                  type="button"
                  class="bn-tinyact"
                  :aria-pressed="watching[`ds:${d.name}`] ? 'true' : 'false'"
                  @click="toggleWatchStream(d.name)"
                >
                  {{ watching[`ds:${d.name}`] ? 'stop' : 'watch' }}
                </button>
              </div>
            </template>
          </div>
        </div>

        <div class="bn-module">
          <div class="bn-mh">analog scale</div>
          <div class="bn-mb">
            <p class="bn-note" style="margin-top: 0">
              gauges and scopes run 0 to {{ adcMax }} counts. that comes from the
              {{ adcSource }}, not from the wire, since hello carries no adc width.
            </p>
          </div>
        </div>

        <div v-for="m in modules" :key="m.name" class="bn-module">
          <div class="bn-mh">{{ m.name }}</div>
          <div class="bn-mb">
            <template v-if="m.name === 'servo'">
              <div class="bn-knob">
                <label class="bn-klabel" :for="`servo-${m.name}`">
                  angle <b>{{ servoAngle[m.name] ?? 90 }}</b>
                </label>
                <input
                  :id="`servo-${m.name}`"
                  v-model.number="servoAngle[m.name]"
                  type="range"
                  min="0"
                  max="180"
                  step="1"
                  @change="moveServo(m.name)"
                />
              </div>
              <div class="bn-fcaps">
                <button
                  type="button"
                  class="bn-tinyact"
                  @click="attachServo(m.name, m.pins[0] ?? 0)"
                >
                  attach on pin {{ m.pins[0] ?? 0 }}
                </button>
              </div>
            </template>

            <template v-else-if="m.name === 'neopixel'">
              <div class="bn-fcaps">
                <button
                  v-for="s in SWATCHES"
                  :key="s.name"
                  type="button"
                  class="bn-tinyact"
                  :style="swatchStyle(s.rgb)"
                  @click="fillPixels(m.name, s.rgb)"
                >
                  {{ s.name }}
                </button>
              </div>
              <div class="bn-fcaps">
                <button
                  type="button"
                  class="bn-tinyact"
                  @click="beginPixels(m.name, m.pins[0] ?? 0)"
                >
                  init 8 px on pin {{ m.pins[0] ?? 0 }}
                </button>
              </div>
            </template>

            <template v-else>
              <div class="bn-knob">
                <label class="bn-klabel" :for="`cmd-${m.name}`">command byte, hex</label>
                <input :id="`cmd-${m.name}`" v-model="command[m.name]" type="text" placeholder="02" />
              </div>
              <div class="bn-knob">
                <label class="bn-klabel" :for="`data-${m.name}`">data bytes, hex</label>
                <input
                  :id="`data-${m.name}`"
                  v-model="payload[m.name]"
                  type="text"
                  placeholder="5a 01"
                />
              </div>
              <div class="bn-fcaps">
                <button type="button" class="bn-tinyact" @click="sendCommand(m.name)">send</button>
              </div>
              <div v-if="reply[m.name]" class="bn-io is-dim">{{ reply[m.name] }}</div>
            </template>

            <div class="bn-fcaps">
              <span class="bn-chipx">v{{ m.versionMajor }}.{{ m.versionMinor }}</span>
              <span v-for="pin in m.pins" :key="pin" class="bn-chipx">{{ pinName(pin) }}</span>
            </div>
          </div>
        </div>

        <div class="bn-module">
          <div class="bn-mh">firmware</div>
          <div class="bn-mb">
            <p class="bn-note" style="margin-top: 0">
              flashing happens on the conduyt playground, not in this panel. it picks the build for
              your board, writes it, and hands the port back so you can reconnect here.
            </p>
            <p class="bn-note">{{ browserFlashSummary() }}</p>
            <div class="bn-fcaps">
              <a class="bn-tinyact" :href="PLAYGROUND" target="_blank" rel="noreferrer noopener">
                open the playground
              </a>
            </div>
          </div>
        </div>
      </div>
    </template>

    <ArmDialog
      v-if="arming"
      :device-id="props.deviceId"
      :capability="arming"
      @close="arming = null"
    />
  </div>
</template>

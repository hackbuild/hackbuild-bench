<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import type { HelloResp } from 'conduyt-js'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { bus } from '@/core/bus/DeviceBus'
import { CAPABILITIES } from '@/core/capabilities'
import type { ConduytPinMode, ConduytSession } from '@/core/drivers/conduyt'
import { modeDrives, pinModesFor, pinTagsFor } from '@/core/drivers/conduyt'
import { boardProfile, browserFlashSummary, pinLabel } from '@/core/drivers/conduyt/profiles'
import { fromHex, toHex } from '@/core/format'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { useDevices } from '@/stores/devices'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const stream = useDeviceStream(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const armedGpio = computed(() => node.value?.armed.includes(CAPABILITIES.GPIO_DRIVE) ?? false)
const armedBus = computed(() => node.value?.armed.includes(CAPABILITIES.BUS_DRIVE) ?? false)

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

const hello = ref<HelloResp | null>(null)
const error = ref<string | null>(null)
const scanning = ref(false)
const addresses = ref<number[]>([])
const pinMode = reactive<Record<number, ConduytPinMode>>({})
const servoAngle = reactive<Record<string, number>>({})
const command = reactive<Record<string, string>>({})
const payload = reactive<Record<string, string>>({})
const reply = reactive<Record<string, string>>({})
const watching = reactive<Record<string, boolean>>({})
const stops = new Map<string, () => void>()

function session(): ConduytSession | undefined {
  return bus.session<ConduytSession>(props.deviceId)
}

const profile = computed(() => boardProfile(node.value?.info['board id'] ?? ''))

const pins = computed(() =>
  (hello.value?.pins ?? []).map((p) => ({
    pin: p.pin,
    label: pinLabel(profile.value, p.pin),
    modes: pinModesFor(p.capabilities),
    tags: pinTagsFor(p.capabilities),
  })),
)

const modules = computed(() => hello.value?.modules ?? [])
const datastreams = computed(() => hello.value?.datastreams ?? [])
const hasI2c = computed(() => (hello.value?.i2cBuses ?? 0) > 0)
const moduleNames = computed(() => modules.value.map((m) => m.name).join(', '))

const firmware = computed(() =>
  hello.value ? `${hello.value.firmwareName} ${hello.value.firmwareVersion.join('.')}` : 'none',
)
const mcuId = computed(() => (hello.value ? toHex(hello.value.mcuId, '') : ''))

/** Keeps the swatch label readable against the colour it sends. */
function swatchStyle(rgb: number[]): Record<string, string> {
  const [r, g, b] = rgb
  const light = 0.299 * r + 0.587 * g + 0.114 * b > 150
  return {
    background: `rgb(${r},${g},${b})`,
    color: light ? 'var(--hb-ink)' : 'var(--hb-paper)',
  }
}

function readingOf(name: string): string {
  const r = stream.readings.value[name]
  if (!r) return '-'
  return r.unit ? `${r.value} ${r.unit}` : String(r.value)
}

function isHigh(pin: number): boolean {
  return (stream.readings.value[`pin ${pin}`]?.value ?? 0) > 0
}

function isUsed(pin: number): boolean {
  const mode = pinMode[pin]
  return mode !== undefined && mode !== 'input'
}

function guard(run: (s: ConduytSession) => Promise<unknown>): void {
  error.value = null
  const s = session()
  if (!s) {
    error.value = 'this device is no longer attached'
    return
  }
  void run(s).catch((err: unknown) => {
    error.value = err instanceof Error ? err.message : String(err)
  })
}

function applyMode(pin: number): void {
  guard((s) => s.setPinMode(pin, pinMode[pin]))
}

function drive(pin: number, value: number): void {
  guard((s) => s.writePin(pin, value))
}

function readOnce(pin: number): void {
  guard((s) => (pinMode[pin] === 'analog' ? s.analogRead(pin) : s.readPin(pin)))
}

function toggleWatchPin(pin: number): void {
  const key = `pin:${pin}`
  if (release(key)) return
  guard(async (s) => {
    stops.set(key, s.subscribePin(pin, pinMode[pin] === 'analog'))
    watching[key] = true
  })
}

function toggleWatchStream(name: string): void {
  const key = `ds:${name}`
  if (release(key)) return
  guard(async (s) => {
    stops.set(key, s.subscribeDatastream(name))
    watching[key] = true
  })
}

/** Stops a running subscription. True when there was one to stop. */
function release(key: string): boolean {
  const stop = stops.get(key)
  if (!stop) return false
  stop()
  stops.delete(key)
  watching[key] = false
  return true
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

function moveServo(name: string): void {
  const angle = Math.max(0, Math.min(180, Math.round(servoAngle[name] ?? 90)))
  guard((s) => s.moduleCommand(name, SERVO_WRITE, new Uint8Array([angle])))
}

function attachServo(name: string, pin: number): void {
  // pin, then min and max pulse width in microseconds, little endian.
  const data = new Uint8Array([pin, 544 & 0xff, 544 >> 8, 2400 & 0xff, 2400 >> 8])
  guard((s) => s.moduleCommand(name, SERVO_ATTACH, data))
}

function fillPixels(name: string, rgb: number[]): void {
  guard(async (s) => {
    await s.moduleCommand(name, NEOPIXEL_FILL, new Uint8Array(rgb))
    await s.moduleCommand(name, NEOPIXEL_SHOW)
  })
}

function beginPixels(name: string, pin: number): void {
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
  guard(async (s) => {
    const answer = await s.moduleCommand(name, cmd, fromHex(payload[name] ?? ''))
    reply[name] = answer.length ? toHex(answer) : 'acknowledged, no data back'
  })
}

function ping(): void {
  guard((s) => s.ping())
}

function resetBoard(): void {
  guard((s) => s.resetBoard())
}

onMounted(() => {
  hello.value = session()?.getHello() ?? null
  for (const p of hello.value?.pins ?? []) {
    pinMode[p.pin] = pinModesFor(p.capabilities)[0] ?? 'input'
  }
  for (const m of hello.value?.modules ?? []) {
    servoAngle[m.name] = 90
    command[m.name] = ''
    payload[m.name] = ''
  }
})

onBeforeUnmount(() => {
  for (const stop of stops.values()) stop()
  stops.clear()
})
</script>

<template>
  <div>
    <div v-if="!hello" class="bn-banner is-err">
      <HbIcon name="warning" />
      <span>
        this board never answered hello, so there is nothing here to drive. reconnect it, or flash
        conduyt from the playground.
      </span>
    </div>

    <template v-else>
      <div v-if="!armedGpio" class="bn-banner is-warn">
        <HbIcon name="warning" />
        <span>
          reads are live. driving pins, running modules, and writing i2c stay off until you arm
          gpio drive in the bar above, since an output fighting something already driving the line
          damages both.
        </span>
      </div>

      <div v-if="error" class="bn-banner is-err" role="alert">
        <HbIcon name="warning" />
        <span>{{ error }}</span>
      </div>

      <div class="bn-subhead">
        board
        <span class="bn-aside">every field here came back in the hello response</span>
      </div>

      <div class="bn-dinfo">
        <span class="bn-k">firmware</span><span class="bn-v">{{ firmware }}</span>
        <span class="bn-k">board</span>
        <span class="bn-v">{{ profile?.name ?? 'not identified from usb id and pin count' }}</span>
        <span class="bn-k">mcu id</span><span class="bn-v">{{ mcuId }}</span>
        <span class="bn-k">pins</span><span class="bn-v">{{ hello?.pins.length }}</span>
        <span class="bn-k">i2c buses</span><span class="bn-v">{{ hello?.i2cBuses }}</span>
        <span class="bn-k">modules</span>
        <span class="bn-v">{{ moduleNames || 'none loaded' }}</span>
        <span class="bn-k">max payload</span><span class="bn-v">{{ hello?.maxPayload }} bytes</span>
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

      <div class="bn-subhead">
        pins
        <span class="bn-aside">
          modes come from the capability bitmask each pin reported, so a digital only pin has no
          analog option
        </span>
      </div>

      <div class="bn-pingrid">
        <div
          v-for="p in pins"
          :key="p.pin"
          class="bn-pincell"
          :class="{ 'is-used': isUsed(p.pin), 'is-high': isHigh(p.pin) }"
        >
          <div class="bn-ph">
            {{ p.label }}
            <span class="bn-pst"></span>
          </div>
          <div class="bn-fcaps">
            <span v-for="t in p.tags" :key="t" class="bn-chipx">{{ t }}</span>
          </div>
          <select
            v-model="pinMode[p.pin]"
            :aria-label="`mode for ${p.label}`"
            @change="applyMode(p.pin)"
          >
            <option
              v-for="m in p.modes"
              :key="m"
              :value="m"
              :disabled="modeDrives(m) && !armedGpio"
            >
              {{ m }}
            </option>
          </select>
          <div class="bn-val">{{ readingOf(`pin ${p.pin}`) }}</div>
          <div class="bn-fcaps">
            <button type="button" class="bn-tinyact" @click="readOnce(p.pin)">read</button>
            <button type="button" class="bn-tinyact" :disabled="!armedGpio" @click="drive(p.pin, 1)">
              high
            </button>
            <button type="button" class="bn-tinyact" :disabled="!armedGpio" @click="drive(p.pin, 0)">
              low
            </button>
            <button
              type="button"
              class="bn-tinyact"
              :aria-pressed="watching[`pin:${p.pin}`] ? 'true' : 'false'"
              @click="toggleWatchPin(p.pin)"
            >
              watch
            </button>
          </div>
        </div>
      </div>

      <p v-if="!armedGpio" class="bn-note">
        high, low, and the output and pwm modes are disabled until gpio drive is armed.
      </p>

      <div class="bn-subhead">
        modules
        <span class="bn-aside">what the firmware loaded, driven over mod_cmd</span>
      </div>

      <p v-if="!modules.length" class="bn-note">
        this build loaded no modules. add servo, neopixel, dht, or your own to the sketch and they
        appear here after the next hello.
      </p>

      <div v-else class="bn-modules">
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
                  :disabled="!armedGpio"
                  @change="moveServo(m.name)"
                />
              </div>
              <div class="bn-fcaps">
                <button
                  type="button"
                  class="bn-tinyact"
                  :disabled="!armedGpio"
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
                  :disabled="!armedGpio"
                  @click="fillPixels(m.name, s.rgb)"
                >
                  {{ s.name }}
                </button>
              </div>
              <div class="bn-fcaps">
                <button
                  type="button"
                  class="bn-tinyact"
                  :disabled="!armedGpio"
                  @click="beginPixels(m.name, m.pins[0] ?? 0)"
                >
                  init 8 px on pin {{ m.pins[0] ?? 0 }}
                </button>
              </div>
            </template>

            <template v-else>
              <div class="bn-knob">
                <label class="bn-klabel" :for="`cmd-${m.name}`">command byte, hex</label>
                <input
                  :id="`cmd-${m.name}`"
                  v-model="command[m.name]"
                  type="text"
                  placeholder="02"
                  :disabled="!armedGpio"
                />
              </div>
              <div class="bn-knob">
                <label class="bn-klabel" :for="`data-${m.name}`">data bytes, hex</label>
                <input
                  :id="`data-${m.name}`"
                  v-model="payload[m.name]"
                  type="text"
                  placeholder="5a 01"
                  :disabled="!armedGpio"
                />
              </div>
              <div class="bn-fcaps">
                <button
                  type="button"
                  class="bn-tinyact"
                  :disabled="!armedGpio"
                  @click="sendCommand(m.name)"
                >
                  send
                </button>
              </div>
              <div v-if="reply[m.name]" class="bn-io is-dim">{{ reply[m.name] }}</div>
            </template>

            <div class="bn-fcaps">
              <span class="bn-chipx">v{{ m.versionMajor }}.{{ m.versionMinor }}</span>
              <span v-for="pin in m.pins" :key="pin" class="bn-chipx">pin {{ pin }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="bn-modules">
        <div class="bn-module">
          <div class="bn-mh">i2c</div>
          <div class="bn-mb">
            <p v-if="!hasI2c" class="bn-note">
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
            <p v-if="!datastreams.length" class="bn-note">
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
          <div class="bn-mh">firmware</div>
          <div class="bn-mb">
            <p class="bn-note">
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
  </div>
</template>

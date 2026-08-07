<script setup lang="ts">
import { computed, ref } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { useDevices } from '@/stores/devices'
import { bus } from '@/core/bus/DeviceBus'
import { CAPABILITIES } from '@/core/capabilities'
import type { DeviceSession } from '@/core/drivers/types'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const armedGpio = computed(() => node.value?.armed.includes(CAPABILITIES.GPIO_DRIVE) ?? false)
const armedBus = computed(() => node.value?.armed.includes(CAPABILITIES.BUS_DRIVE) ?? false)

type BoardSession = DeviceSession & {
  setPin(pin: number, mode: string, value?: number): Promise<void>
  scanI2c(): Promise<number[]>
  setServo(pin: number, degrees: number): Promise<void>
}

const PINS = [2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23]
const MODES = ['input', 'output low', 'output high', 'servo', 'i2c sda', 'i2c scl']

const pinModes = ref<Record<number, string>>(
  Object.fromEntries(PINS.map((p) => [p, 'input'])),
)
const servo = ref(90)
const addresses = ref<number[]>([])
const scanning = ref(false)
const error = ref<string | null>(null)

function session(): BoardSession | undefined {
  return bus.session<BoardSession>(props.deviceId)
}

async function applyPin(pin: number): Promise<void> {
  error.value = null
  const mode = pinModes.value[pin]
  try {
    await session()?.setPin(pin, mode)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function moveServo(): Promise<void> {
  error.value = null
  const pin = Number(Object.entries(pinModes.value).find(([, m]) => m === 'servo')?.[0])
  if (!Number.isFinite(pin)) {
    error.value = 'set a pin to servo first'
    return
  }
  try {
    await session()?.setServo(pin, servo.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function scan(): Promise<void> {
  error.value = null
  scanning.value = true
  try {
    addresses.value = (await session()?.scanI2c()) ?? []
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    scanning.value = false
  }
}

function isUsed(pin: number): boolean {
  const m = pinModes.value[pin]
  return m !== 'input'
}

function isHigh(pin: number): boolean {
  return pinModes.value[pin] === 'output high'
}
</script>

<template>
  <div>
    <div v-if="!armedGpio" class="bn-banner is-warn">
      <HbIcon name="warning" />
      <span>
        pins read fine as inputs. driving them is behind the arm confirm in the bar
        above, since an output fighting something already driving the line damages both.
      </span>
    </div>

    <p v-if="error" class="bn-note" style="color: var(--hb-err)">{{ error }}</p>

    <div class="bn-subhead">
      pins
      <span class="bn-aside">the board reports what it has when it connects</span>
    </div>

    <div class="bn-pingrid">
      <div
        v-for="pin in PINS"
        :key="pin"
        class="bn-pincell"
        :class="{ 'is-used': isUsed(pin), 'is-high': isHigh(pin) }"
      >
        <div class="bn-ph">gpio{{ pin }} <span class="bn-pst"></span></div>
        <select
          v-model="pinModes[pin]"
          :disabled="!armedGpio"
          @change="applyPin(pin)"
        >
          <option v-for="m in MODES" :key="m" :value="m">{{ m }}</option>
        </select>
        <div class="bn-val">{{ pinModes[pin] }}</div>
      </div>
    </div>

    <div class="bn-modules">
      <div class="bn-module">
        <div class="bn-mh">servo</div>
        <div class="bn-mb">
          <input
            v-model.number="servo"
            type="range"
            min="0"
            max="180"
            style="width: 100%; accent-color: var(--hb-pink)"
            :disabled="!armedGpio"
            @change="moveServo"
          />
          <div class="bn-val">{{ servo }} deg</div>
        </div>
      </div>

      <div class="bn-module">
        <div class="bn-mh">i2c scan</div>
        <div class="bn-mb">
          <HbButton size="sm" :loading="scanning" :disabled="!armedBus" @click="scan">
            scan bus
          </HbButton>
          <div class="bn-fcaps" style="margin-top: 8px">
            <span v-for="a in addresses" :key="a" class="bn-chipx is-pink">
              0x{{ a.toString(16).padStart(2, '0') }}
            </span>
            <span v-if="!addresses.length" class="bn-chipx">nothing found yet</span>
          </div>
        </div>
      </div>

      <div class="bn-module">
        <div class="bn-mh">wiring</div>
        <div class="bn-mb">
          <p style="font-family: var(--hb-body); font-size: 12px; color: var(--hb-ink-3); margin: 0">
            i2c runs on sda 21 and scl 22 by default. tie grounds together and match the
            target voltage before enabling the bus.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstTerminal from '@/components/instruments/InstTerminal.vue'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { bus } from '@/core/bus/DeviceBus'
import type { DeviceSession } from '@/core/drivers/types'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const bench = useBench()
const stream = useDeviceStream(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const streaming = computed(() => node.value?.status === 'streaming')
const busy = ref(false)

const PACKS = [
  { id: 'raw', label: 'raw', icon: 'code' as const },
  { id: 'at', label: 'at', icon: 'satellite' as const },
  { id: 'uboot', label: 'u-boot', icon: 'terminal' as const },
]
const pack = ref('raw')

const baud = computed({
  get: () => node.value?.params.baud ?? 115200,
  set: (v: number) => void devices.configure(props.deviceId, { baud: v }),
})

const BAUDS = [9600, 19200, 38400, 57600, 74880, 115200, 230400, 460800, 921600]

const lines = computed(() =>
  stream.lines.value.map((l) => ({ text: l.text, stream: l.stream, at: l.wall })),
)

async function open(): Promise<void> {
  await devices.start(props.deviceId, 'console')
}

async function close(): Promise<void> {
  await devices.stop(props.deviceId)
}

async function send(text: string): Promise<void> {
  const session = sessionFor()
  if (!session) return
  const line = pack.value === 'at' && !text.toUpperCase().startsWith('AT') ? `AT${text}` : text
  await session.write(`${line}\r\n`)
}

async function autoBaud(): Promise<void> {
  const session = sessionFor()
  if (!session?.autoBaud) return
  busy.value = true
  try {
    const found = await session.autoBaud()
    if (found) baud.value = found
  } finally {
    busy.value = false
  }
}

/** The serial drivers expose write and autoBaud beyond the base session. */
type SerialSession = DeviceSession & {
  write(text: string): Promise<void>
  autoBaud?(): Promise<number | null>
}

function sessionFor(): SerialSession | undefined {
  return bus.session<SerialSession>(props.deviceId)
}

onBeforeUnmount(() => {
  if (streaming.value) void devices.stop(props.deviceId).catch(() => undefined)
})
</script>

<template>
  <div>
    <div class="bn-packs">
      <button
        v-for="p in PACKS"
        :key="p.id"
        type="button"
        class="bn-pack"
        :class="{ 'is-on': pack === p.id }"
        @click="pack = p.id"
      >
        <HbIcon :name="p.icon" :size="10" />{{ p.label }}
      </button>
    </div>

    <div class="bn-knobs" style="margin-top: 0">
      <div class="bn-knob">
        <span class="bn-klabel">baud</span>
        <select v-model.number="baud">
          <option v-for="b in BAUDS" :key="b" :value="b">{{ b }}</option>
        </select>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton size="sm" :loading="busy" @click="autoBaud">auto baud</HbButton>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton v-if="!streaming" variant="danger" size="sm" @click="open">
          <template #icon><HbIcon name="play" /></template>
          open port
        </HbButton>
        <HbButton v-else size="sm" @click="close">
          <template #icon><HbIcon name="stop" /></template>
          close
        </HbButton>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton size="sm" @click="stream.clearLines()">clear</HbButton>
      </div>
    </div>

    <InstTerminal
      :lines="lines"
      :disabled="!streaming"
      placeholder="type a command and press enter"
      @send="send"
    />

    <p v-if="bench.advanced" class="bn-note">
      auto baud samples each common rate for a moment and scores what comes back for
      printable characters and line structure. it does not guess parity or stop bits.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { useDevices } from '@/stores/devices'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { bus } from '@/core/bus/DeviceBus'
import { CAPABILITIES } from '@/core/capabilities'
import { formatClock } from '@/core/format'
import type { DeviceSession } from '@/core/drivers/types'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const stream = useDeviceStream(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const streaming = computed(() => node.value?.status === 'streaming')
const armed = computed(() => node.value?.armed.includes(CAPABILITIES.MESH_TX) ?? false)

const draft = ref('')
const channel = ref(0)
const sendError = ref<string | null>(null)

type MeshSession = DeviceSession & {
  sendText(text: string, channel: number): Promise<void>
}

/** Nodes the radio has heard, newest position wins. */
const nodes = computed(() => {
  const seen = new Map<string, Record<string, unknown>>()
  for (const p of stream.packets.value) {
    const f = p.fields ?? {}
    if (f.type !== 'nodeinfo' && f.nodeNum === undefined) continue
    seen.set(String(f.nodeNum), { ...seen.get(String(f.nodeNum)), ...f, at: p.wall })
  }
  return [...seen.values()]
})

const messages = computed(() =>
  stream.packets.value.filter((p) => p.fields?.type === 'text').slice(0, 60),
)

async function listen(): Promise<void> {
  await devices.start(props.deviceId, 'listen')
}

async function halt(): Promise<void> {
  await devices.stop(props.deviceId)
}

async function send(): Promise<void> {
  sendError.value = null
  const text = draft.value.trim()
  if (!text) return
  const session = bus.session<MeshSession>(props.deviceId)
  if (!session?.sendText) return
  try {
    await session.sendText(text, channel.value)
    draft.value = ''
  } catch (err) {
    sendError.value = err instanceof Error ? err.message : String(err)
  }
}

onBeforeUnmount(() => {
  if (streaming.value) void devices.stop(props.deviceId).catch(() => undefined)
})
</script>

<template>
  <div>
    <div class="bn-knobs" style="margin-top: 0">
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton v-if="!streaming" variant="danger" size="sm" @click="listen">
          <template #icon><HbIcon name="tower-broadcast" /></template>
          listen
        </HbButton>
        <HbButton v-else size="sm" @click="halt">
          <template #icon><HbIcon name="stop" /></template>
          stop
        </HbButton>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">channel</span>
        <select v-model.number="channel">
          <option v-for="c in 8" :key="c" :value="c - 1">{{ c - 1 }}</option>
        </select>
      </div>
    </div>

    <div class="bn-statgrid">
      <div class="bn-statc">
        <div class="bn-k">nodes</div>
        <div class="bn-v">{{ nodes.length }}</div>
      </div>
      <div class="bn-statc">
        <div class="bn-k">packets</div>
        <div class="bn-v">{{ stream.packetCount.value }}</div>
      </div>
      <div class="bn-statc">
        <div class="bn-k">messages</div>
        <div class="bn-v">{{ messages.length }}</div>
      </div>
      <div class="bn-statc">
        <div class="bn-k">my node</div>
        <div class="bn-v">{{ node?.info.myNode ?? '?' }}</div>
      </div>
    </div>

    <div class="bn-subhead">nodes heard</div>
    <div class="bn-list">
      <div v-for="n in nodes" :key="String(n.nodeNum)" class="bn-row">
        <span class="bn-a">{{ n.longName ?? n.shortName ?? n.nodeNum }}</span>
        <span class="bn-b">
          {{ n.latitude ? `${n.latitude}, ${n.longitude}` : 'no position' }}
        </span>
        <span class="bn-c">{{ n.battery ? `${n.battery}%` : '' }}</span>
      </div>
      <div v-if="!nodes.length" class="bn-row">
        <span class="bn-b">nothing heard yet. the mesh is quiet until a node beacons.</span>
      </div>
    </div>

    <div class="bn-subhead" style="margin-top: 14px">messages</div>
    <div class="bn-list">
      <div v-for="m in messages" :key="m.seq" class="bn-row">
        <span class="bn-a">{{ m.fields?.from ?? 'unknown' }}</span>
        <span class="bn-b">{{ m.fields?.text }}</span>
        <span class="bn-c">{{ formatClock(m.wall) }}</span>
      </div>
      <div v-if="!messages.length" class="bn-row">
        <span class="bn-b">no text traffic yet</span>
      </div>
    </div>

    <div class="bn-termin" style="margin-top: 10px">
      <span>&gt;</span>
      <input
        v-model="draft"
        type="text"
        :placeholder="armed ? 'type a message and press enter' : 'arm mesh tx to send'"
        :disabled="!armed || !streaming"
        @keydown.enter="send"
      />
    </div>
    <p v-if="sendError" class="bn-note" style="color: var(--hb-err)">{{ sendError }}</p>
    <p v-else-if="!armed" class="bn-note">
      receiving is free. sending puts a message on the mesh where every node relays it,
      so it sits behind one arm confirm in the bar above.
    </p>
  </div>
</template>

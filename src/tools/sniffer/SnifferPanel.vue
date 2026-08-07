<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstPacketList from '@/components/instruments/InstPacketList.vue'
import InstHexView from '@/components/instruments/InstHexView.vue'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { formatClock, toHex } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'
import type { PacketRecord } from '@/core/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const bench = useBench()
const stream = useDeviceStream(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const streaming = computed(() => node.value?.status === 'streaming')

const filter = ref('')
const selected = ref<PacketRecord | null>(null)

const shown = computed(() => {
  const f = filter.value.trim().toLowerCase()
  const list = f
    ? stream.packets.value.filter(
        (p) =>
          p.summary?.toLowerCase().includes(f) ||
          JSON.stringify(p.fields ?? {}).toLowerCase().includes(f),
      )
    : stream.packets.value
  return list.map((p) => ({
    id: `${p.source}-${p.seq}`,
    a: String(p.fields?.address ?? p.fields?.mac ?? p.proto),
    b: p.summary ?? p.proto,
    c: p.rssi !== undefined ? `${p.rssi}` : '',
    decode: p.fields ? summarise(p.fields) : undefined,
    raw: p,
  }))
})

function summarise(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .filter(([k]) => k !== 'address' && k !== 'mac')
    .map(([k, v]) => `${k} ${String(v)}`)
    .join('  ')
}

async function sniff(): Promise<void> {
  await devices.start(props.deviceId, 'ble')
}

async function halt(): Promise<void> {
  await devices.stop(props.deviceId)
}

function pick(id: string): void {
  selected.value = shown.value.find((p) => p.id === id)?.raw ?? null
}

function sendToAnalysis(): void {
  if (selected.value) {
    bench.sendToAnalysis(selected.value.summary ?? 'packet', selected.value.bytes)
  }
}

onBeforeUnmount(() => {
  if (streaming.value) void devices.stop(props.deviceId).catch(() => undefined)
})
</script>

<template>
  <div>
    <div class="bn-knobs" style="margin-top: 0">
      <div class="bn-knob" style="min-width: 200px">
        <span class="bn-klabel">filter</span>
        <input v-model="filter" type="text" placeholder="mac, name, or any field" />
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton v-if="!streaming" variant="danger" size="sm" @click="sniff">
          <template #icon><HbIcon name="satellite-dish" /></template>
          sniff
        </HbButton>
        <HbButton v-else size="sm" @click="halt">
          <template #icon><HbIcon name="stop" /></template>
          stop
        </HbButton>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton size="sm" @click="stream.clearPackets()">clear</HbButton>
      </div>
    </div>

    <div class="bn-subhead">
      packets
      <span class="bn-aside">{{ stream.packetCount.value }} seen</span>
    </div>

    <InstPacketList
      :packets="shown"
      empty-text="nothing yet. hit sniff and wait for something to advertise."
      @pick="pick"
    />

    <div v-if="selected" class="bn-capcard">
      <div class="bn-kv">
        <span class="bn-k">seen</span>
        <span class="bn-v">{{ formatClock(selected.wall) }}</span>
        <span class="bn-k">proto</span>
        <span class="bn-v">{{ selected.proto }}</span>
        <span class="bn-k">bytes</span>
        <span class="bn-v">{{ toHex(selected.bytes) }}</span>
      </div>
      <InstHexView v-if="bench.advanced" :bytes="selected.bytes" />
      <div class="bn-acts" style="margin-top: 10px">
        <HbButton size="sm" @click="sendToAnalysis">
          <template #icon><HbIcon name="wand" /></template>
          send to analysis
        </HbButton>
      </div>
    </div>
  </div>
</template>

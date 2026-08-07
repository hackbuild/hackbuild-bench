<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { useDevices } from '@/stores/devices'
import { useDeviceStream } from '@/composables/useDeviceStream'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const stream = useDeviceStream(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const streaming = computed(() => node.value?.status === 'streaming')

/** One row per bssid, keeping the most recent sighting. */
const networks = computed(() => {
  const seen = new Map<string, Record<string, unknown>>()
  for (const p of stream.packets.value) {
    const f = p.fields ?? {}
    const key = String(f.bssid ?? f.ssid ?? p.seq)
    if (!seen.has(key)) seen.set(key, { ...f, rssi: p.rssi })
  }
  return [...seen.values()]
})

async function scan(): Promise<void> {
  await devices.start(props.deviceId, 'survey')
}

async function halt(): Promise<void> {
  await devices.stop(props.deviceId)
}

onBeforeUnmount(() => {
  if (streaming.value) void devices.stop(props.deviceId).catch(() => undefined)
})
</script>

<template>
  <div>
    <div class="bn-banner">
      <HbIcon name="wifi" />
      <span>
        this reads the appliance rest api straight from the tab. survey is passive, so it
        only lists what is already broadcasting.
      </span>
    </div>

    <div class="bn-knobs" style="margin-top: 0">
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton v-if="!streaming" variant="danger" size="sm" @click="scan">
          <template #icon><HbIcon name="magnifying-glass-location" /></template>
          recon scan
        </HbButton>
        <HbButton v-else size="sm" @click="halt">
          <template #icon><HbIcon name="stop" /></template>
          stop
        </HbButton>
      </div>
    </div>

    <div class="bn-subhead">
      networks
      <span class="bn-aside">{{ networks.length }} seen</span>
    </div>
    <div class="bn-list">
      <div v-for="n in networks" :key="String(n.bssid)" class="bn-row">
        <span class="bn-a">{{ n.ssid || '(hidden)' }}</span>
        <span class="bn-b">{{ n.encryption ?? 'open' }} ch {{ n.channel ?? '?' }}</span>
        <span class="bn-c">{{ n.rssi ?? '' }}</span>
      </div>
      <div v-if="!networks.length" class="bn-row">
        <span class="bn-b">nothing yet</span>
      </div>
    </div>
  </div>
</template>

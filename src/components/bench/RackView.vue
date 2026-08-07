<script setup lang="ts">
import DeviceFaceplate from './DeviceFaceplate.vue'
import EmptyBench from './EmptyBench.vue'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'

const devices = useDevices()
const bench = useBench()

function pick(id: string): void {
  devices.focus(id)
  bench.setView('focus')
}
</script>

<template>
  <EmptyBench v-if="!devices.nodes.length" />
  <div v-else class="bn-rack">
    <DeviceFaceplate
      v-for="node in devices.nodes"
      :key="node.id"
      :node="node"
      @pick="pick"
    />
  </div>
</template>

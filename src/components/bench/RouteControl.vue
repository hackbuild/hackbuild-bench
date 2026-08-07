<script setup lang="ts">
import { computed } from 'vue'
import { useBench } from '@/stores/bench'
import type { RouteTarget } from '@/stores/bench'

interface Props {
  deviceId: string
}

const props = defineProps<Props>()
const bench = useBench()

const OPTIONS: Array<{ value: RouteTarget; label: string }> = [
  { value: 'off', label: 'off' },
  { value: 'analysis', label: 'analysis' },
  { value: 'recorder', label: 'recorder' },
  { value: 'automation', label: 'new automation' },
]

const value = computed({
  get: () => bench.routeFor(props.deviceId),
  set: (v: RouteTarget) => bench.setRoute(props.deviceId, v),
})
</script>

<template>
  <label class="bn-route">
    route
    <select v-model="value" aria-label="send this device output to">
      <option v-for="o in OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
  </label>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  /** Position of the cursor across the band, 0 to 100. */
  percent: number
  label: string
}

const props = defineProps<Props>()

const at = computed(() => {
  if (!Number.isFinite(props.percent)) return 0
  return Math.max(0, Math.min(100, props.percent))
})
</script>

<template>
  <div
    class="bn-sweep"
    role="progressbar"
    :aria-valuenow="Math.round(at)"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-label="'sweep position, ' + label"
  >
    <div class="bn-stripes"></div>
    <div class="bn-lab">{{ label }}</div>
    <div class="bn-cursor" :style="{ left: at + '%' }"></div>
  </div>
</template>

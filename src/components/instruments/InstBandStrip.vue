<script setup lang="ts">
import { computed } from 'vue'

export interface BandSpan {
  lowHz: number
  highHz: number
  label: string
}

interface Props {
  /** Edges of the whole span in Hz. */
  lowHz: number
  highHz: number
  /** The visible part of the span, as fractions of it. */
  view?: [number, number]
  bands: BandSpan[]
}

const props = withDefaults(defineProps<Props>(), {
  view: () => [0, 1] as [number, number],
})

const shown = computed(() => {
  const span = props.highHz - props.lowHz
  if (!(span > 0)) return []
  const lo = props.lowHz + props.view[0] * span
  const hi = props.lowHz + props.view[1] * span
  const width = hi - lo
  return props.bands
    .filter((b) => b.highHz > lo && b.lowHz < hi)
    .map((b) => {
      const left = Math.max(0, (b.lowHz - lo) / width)
      const right = Math.min(1, (b.highHz - lo) / width)
      return { label: b.label, left, width: right - left }
    })
})
</script>

<template>
  <div class="bn-bands" role="list" aria-label="bands in view">
    <span
      v-for="b in shown"
      :key="b.label"
      role="listitem"
      :title="b.label"
      :style="{ left: b.left * 100 + '%', width: b.width * 100 + '%' }"
    >{{ b.label }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  /** Signal level in dB, clamped into the floor to ceiling window. */
  db: number
  bars?: number
  floorDb?: number
  ceilDb?: number
}

const props = withDefaults(defineProps<Props>(), {
  bars: 24,
  floorDb: -90,
  ceilDb: -20,
})

const level = computed(() => {
  const span = props.ceilDb - props.floorDb
  if (!(span > 0) || !Number.isFinite(props.db)) return 0
  return Math.max(0, Math.min(1, (props.db - props.floorDb) / span))
})

interface Bar {
  hot: boolean
  height: string
}

/** Bars are a fixed scale. The level decides how many stand up, not how tall
 * the scale is, so the hot quarter stays in the same place. */
const segments = computed<Bar[]>(() => {
  const count = Math.max(1, Math.round(props.bars))
  const out: Bar[] = []
  for (let i = 0; i < count; i++) {
    const at = (i + 1) / count
    out.push({ hot: at > 0.75, height: at <= level.value ? '100%' : '12%' })
  }
  return out
})

const readout = computed(() => `${Math.round(props.db)} dB`)
</script>

<template>
  <div
    class="bn-smeter"
    role="meter"
    :aria-valuenow="Math.round(db)"
    :aria-valuemin="floorDb"
    :aria-valuemax="ceilDb"
    :aria-label="'signal level, ' + readout"
  >
    <i
      v-for="(bar, i) in segments"
      :key="i"
      :class="{ 'is-hot': bar.hot }"
      :style="{ height: bar.height }"
    ></i>
  </div>
</template>

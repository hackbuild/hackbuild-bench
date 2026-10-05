<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  /** Carrier on widths, any unit, in order. */
  pulses: number[]
  /** Carrier off widths after each pulse, same unit. */
  gaps: number[]
  /** Accessible description of what the trace shows. */
  label?: string
}

const props = withDefaults(defineProps<Props>(), {
  label: 'pulse train',
})

/**
 * The last gap is the silence that ended the burst and would flatten
 * everything else, so it is drawn no wider than the widest pulse.
 */
const path = computed(() => {
  const n = Math.min(props.pulses.length, props.gaps.length)
  if (!n) return { d: '', w: 1 }
  const widest = Math.max(...props.pulses.slice(0, n), 1)
  let x = 0
  let d = 'M0 9'
  for (let i = 0; i < n; i++) {
    const g = i === n - 1 ? Math.min(props.gaps[i], widest) : props.gaps[i]
    d += ` V1 H${x + props.pulses[i]} V9 H${x + props.pulses[i] + g}`
    x += props.pulses[i] + g
  }
  return { d, w: Math.max(x, 1) }
})
</script>

<template>
  <svg
    class="bn-ptrain"
    :viewBox="`0 0 ${path.w} 10`"
    preserveAspectRatio="none"
    role="img"
    :aria-label="label"
  >
    <path :d="path.d" vector-effect="non-scaling-stroke" />
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface Props {
  /** Received level in dBm. */
  rssi: number
  floorDb?: number
  ceilDb?: number
}

const props = withDefaults(defineProps<Props>(), {
  floorDb: -90,
  ceilDb: -30,
})

const percent = computed(() => {
  const span = props.ceilDb - props.floorDb
  if (!(span > 0) || !Number.isFinite(props.rssi)) return 0
  return Math.max(0, Math.min(100, ((props.rssi - props.floorDb) / span) * 100))
})

const word = computed(() => {
  const v = percent.value
  if (v > 78) return 'red hot'
  if (v > 55) return 'warmer'
  if (v > 35) return 'lukewarm'
  return 'cold'
})

// Free space falloff is not going to hold indoors, so the distance line reads
// as an order of magnitude rather than a measurement.
const metres = computed(() => Math.max(1, Math.round((100 - percent.value) / 12)))

const readout = computed(() => `${Math.round(props.rssi)} dBm`)
</script>

<template>
  <div>
    <div class="bn-huntword">{{ word }}</div>
    <div
      class="bn-dfmeter"
      role="meter"
      :aria-valuenow="Math.round(rssi)"
      :aria-valuemin="floorDb"
      :aria-valuemax="ceilDb"
      :aria-label="'signal strength, ' + readout"
    >
      <i :style="{ width: percent + '%' }"></i>
      <span>{{ readout }}</span>
    </div>
    <p class="bn-note">roughly {{ metres }} m away, walk and watch the bar</p>
  </div>
</template>

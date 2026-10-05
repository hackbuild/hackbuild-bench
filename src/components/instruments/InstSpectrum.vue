<script setup lang="ts">
import { computed, useId } from 'vue'
import InstScope from './InstScope.vue'
import type { ScopeMarker } from './InstScope.vue'
import InstWaterfall from './InstWaterfall.vue'
import InstFreqAxis from './InstFreqAxis.vue'
import InstBandStrip from './InstBandStrip.vue'
import type { BandSpan } from './InstBandStrip.vue'
import type { Band } from './useTuningPointer'
import { PALETTES } from '@/core/palettes'
import type { PaletteName } from '@/core/palettes'

/**
 * A spectrum stage: the trace, the frequency axis, the band plan and the
 * waterfall stacked on one void, the way SDR++ and gqrx lay them out, with
 * the zoom and the colour map in its head.
 */
interface Props {
  bins: Float32Array | null
  minDb?: number
  maxDb?: number
  demo?: boolean
  view?: [number, number]
  /** Edges of the whole span in Hz. */
  lowHz: number
  highHz: number
  marker?: number | null
  band?: Band
  markerLabel?: string
  interactive?: boolean
  pickable?: boolean
  hold?: Float32Array | null
  floor?: Float32Array | null
  markers?: ScopeMarker[]
  bands?: BandSpan[]
  rowEvery?: number
  traceHeight?: number
  fallHeight?: number
  /** What the stage's head says on its left. */
  title?: string
}

const props = withDefaults(defineProps<Props>(), {
  minDb: -100,
  maxDb: -10,
  demo: false,
  view: () => [0, 1] as [number, number],
  marker: null,
  band: () => [0, 0] as Band,
  markerLabel: '',
  interactive: false,
  pickable: false,
  hold: null,
  floor: null,
  markers: () => [],
  bands: () => [],
  rowEvery: 1,
  traceHeight: 190,
  fallHeight: 150,
  title: 'spectrum',
})

const palette = defineModel<PaletteName>('palette', { default: 'kerf' })

const emit = defineEmits<{
  tune: [fraction: number, snap: boolean]
  width: [fraction: number]
  pick: [fraction: number]
  step: [steps: number, fine: boolean]
  zoom: [factor: number, about: number]
  pan: [delta: number]
  /** Back to the whole span. */
  fit: []
}>()

const uid = useId()
const span = computed(() => props.highHz - props.lowHz)
const zoomed = computed(() => props.view[1] - props.view[0] < 0.999)
const zoomTimes = computed(() => 1 / Math.max(1e-6, props.view[1] - props.view[0]))
/** Zoom buttons keep the listening point in view when there is one. */
const about = computed(() => props.marker ?? (props.view[0] + props.view[1]) / 2)
</script>

<template>
  <div class="bn-spec" role="group" :aria-label="title">
    <div class="bn-spec-hd">
      <span class="bn-spec-title">{{ title }}</span>
      <span v-if="zoomed" class="bn-spec-note">zoom {{ zoomTimes < 10 ? zoomTimes.toFixed(1) : Math.round(zoomTimes) }}x</span>
      <span class="bn-spec-tools">
        <button type="button" class="bn-spec-btn" aria-label="zoom out" @click="emit('zoom', 1 / 1.5, about)">-</button>
        <button type="button" class="bn-spec-btn" aria-label="zoom in" @click="emit('zoom', 1.5, about)">+</button>
        <button type="button" class="bn-spec-btn" :disabled="!zoomed" @click="emit('fit')">fit</button>
        <label class="bn-spec-label" :for="`${uid}-pal`">colour</label>
        <select :id="`${uid}-pal`" v-model="palette" class="bn-spec-select">
          <option v-for="p in PALETTES" :key="p.name" :value="p.name">{{ p.label }}</option>
        </select>
      </span>
    </div>
    <InstScope
      :bins="bins"
      :height="traceHeight"
      ruled
      db-axis
      :auto="false"
      :min-db="minDb"
      :max-db="maxDb"
      :demo="demo"
      :view="view"
      :low-hz="lowHz"
      :high-hz="highHz"
      :marker="marker"
      :band="band"
      :marker-label="markerLabel"
      :interactive="interactive"
      :pickable="pickable"
      :hold="hold"
      :floor="floor"
      :markers="markers"
      :palette="palette"
      @tune="(f, s) => emit('tune', f, s)"
      @width="(f) => emit('width', f)"
      @pick="(f) => emit('pick', f)"
      @step="(n, fine) => emit('step', n, fine)"
      @zoom="(k, a) => emit('zoom', k, a)"
      @pan="(d) => emit('pan', d)"
    />
    <InstFreqAxis
      v-if="span > 0"
      :low-hz="lowHz"
      :high-hz="highHz"
      :view="view"
      :marks="marker === null ? [] : [marker]"
      @pan="(d) => emit('pan', d)"
      @zoom="(k, a) => emit('zoom', k, a)"
    />
    <InstBandStrip v-if="span > 0 && bands.length" :low-hz="lowHz" :high-hz="highHz" :view="view" :bands="bands" />
    <InstWaterfall
      :bins="bins"
      :height="fallHeight"
      :auto="false"
      :min-db="minDb"
      :max-db="maxDb"
      :demo="demo"
      :view="view"
      :marker="marker"
      :band="band"
      :interactive="interactive"
      :row-every="rowEvery"
      :palette="palette"
      @tune="(f, s) => emit('tune', f, s)"
      @width="(f) => emit('width', f)"
      @step="(n, fine) => emit('step', n, fine)"
      @zoom="(k, a) => emit('zoom', k, a)"
      @pan="(d) => emit('pan', d)"
    />
  </div>
</template>

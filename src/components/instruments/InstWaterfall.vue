<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AutoRange,
  demoLevel,
  fitCanvas,
  normalise,
  onReducedMotion,
  peakAt,
  peakBetween,
  prefersReducedMotion,
  readTokens,
} from './canvas'
import type { Screen, ScreenTokens } from './canvas'
import { useTuningPointer } from './useTuningPointer'
import type { Band } from './useTuningPointer'
import { lutIndex, paletteLut } from '@/core/palettes'
import type { PaletteName } from '@/core/palettes'

interface Props {
  /** dB magnitudes, low bin to high bin. One frame becomes one row. */
  bins: Float32Array | null
  height?: number
  /** Fixed display window. Ignored unless auto is turned off. */
  minDb?: number
  maxDb?: number
  /** Follow the data instead of using minDb and maxDb. */
  auto?: boolean
  /** Scroll a placeholder while bins is null. */
  demo?: boolean
  /** Listening point as a fraction of the span. null draws no marker. */
  marker?: number | null
  /** The passband around the marker, as fractions of the span measured from it. */
  band?: Band
  /** Let a pointer move the listening point. The keyboard is the trace's. */
  interactive?: boolean
  /** The visible part of the span, as fractions of it. */
  view?: [number, number]
  /** Paint a row for every this many frames, so the history covers more time. */
  rowEvery?: number
  palette?: PaletteName
}

const props = withDefaults(defineProps<Props>(), {
  height: 120,
  minDb: -100,
  maxDb: -10,
  auto: true,
  demo: false,
  marker: null,
  band: () => [0, 0] as Band,
  interactive: false,
  view: () => [0, 1] as [number, number],
  rowEvery: 1,
  palette: 'kerf',
})

const emit = defineEmits<{
  tune: [fraction: number, snap: boolean]
  width: [fraction: number]
  step: [steps: number, fine: boolean]
  zoom: [factor: number, about: number]
  pan: [delta: number]
}>()

const viewW = computed(() => Math.max(1e-6, props.view[1] - props.view[0]))

function toSpan(x: number): number {
  return props.view[0] + x * viewW.value
}
function toScreen(f: number): number {
  return (f - props.view[0]) / viewW.value
}

/** The bins inside the view, so a zoomed history spends every column on them. */
function visible(bins: Float32Array): Float32Array {
  const n = bins.length
  const lo = Math.max(0, Math.floor(props.view[0] * n))
  const hi = Math.min(n, Math.max(lo + 2, Math.ceil(props.view[1] * n)))
  return lo === 0 && hi === n ? bins : bins.subarray(lo, hi)
}

const canvas = ref<HTMLCanvasElement | null>(null)
// the waterfall scrolls its own canvas, so a marker drawn onto it would slide
// down with the history. it sits over the top instead.
const shell = ref<HTMLElement | null>(null)

const { cursor, handlers } = useTuningPointer({
  el: shell,
  view: () => props.view,
  marker: () => props.marker,
  band: () => props.band,
  role: () => (props.interactive ? 'tune' : 'none'),
  onTune: (f, snap) => emit('tune', f, snap),
  onWidth: (f) => emit('width', f),
  onPick: () => undefined,
  onStep: (n, fine) => emit('step', n, fine),
  onZoom: (factor, about) => emit('zoom', factor, about),
  onPan: (d) => emit('pan', d),
})

const range = new AutoRange()

let tokens: ScreenTokens | null = null
let raf = 0
let timer = 0
let phase = 0
let observer: ResizeObserver | null = null
let stopMotion: (() => void) | null = null

function surface(): Screen | null {
  const el = canvas.value
  if (!el) return null
  const screen = fitCanvas(el, false)
  if (screen?.resized && tokens) {
    screen.ctx.fillStyle = tokens.screen
    screen.ctx.fillRect(0, 0, screen.w, screen.h)
  }
  return screen
}

/** Scrolls the history down one device pixel and paints the new top row. */
function pushRow(level: (x: number, w: number) => number): void {
  const screen = surface()
  if (!screen) return
  const { ctx, w, h } = screen
  const el = canvas.value
  if (!el || h < 2) return
  ctx.drawImage(el, 0, 0, w, h - 1, 0, 1, w, h - 1)
  const row = ctx.createImageData(w, 1)
  const lut = paletteLut(props.palette)
  for (let x = 0; x < w; x++) {
    const k = lutIndex(level(x, w)) * 3
    const o = x * 4
    row.data[o] = lut[k]
    row.data[o + 1] = lut[k + 1]
    row.data[o + 2] = lut[k + 2]
    row.data[o + 3] = 255
  }
  ctx.putImageData(row, 0, 0)
}

let skipped = 0

function fromBins(bins: Float32Array): void {
  const shown = visible(bins)
  const win = props.auto ? range.update(shown) : { minDb: props.minDb, maxDb: props.maxDb }
  if (++skipped < Math.max(1, props.rowEvery)) return
  skipped = 0
  const full = viewW.value >= 0.999
  pushRow((x, w) => {
    const v = full ? peakAt(bins, x, w) : peakBetween(bins, toSpan(x / w), toSpan((x + 1) / w))
    // the gamma keeps the noise floor dark so carriers read as the signal.
    return normalise(v, win.minDb, win.maxDb) ** 1.4
  })
}

/** Wipes the history, for a change that makes the old rows mean something else. */
function clearHistory(): void {
  const screen = surface()
  if (!screen || !tokens) return
  screen.ctx.fillStyle = tokens.screen
  screen.ctx.fillRect(0, 0, screen.w, screen.h)
  range.reset()
}

/**
 * The placeholder as one still picture, for reduced motion. A single pushed
 * row on a cleared canvas would read as an empty black box.
 */
function stillPlaceholder(): void {
  const screen = surface()
  if (!screen) return
  const { ctx, w, h } = screen
  const img = ctx.createImageData(w, h)
  const lut = paletteLut(props.palette)
  for (let y = 0; y < h; y++) {
    const at = phase + (h - y) * 0.08
    for (let x = 0; x < w; x++) {
      const k = lutIndex(demoLevel(x, w, at)) * 3
      const o = (y * w + x) * 4
      img.data[o] = lut[k]
      img.data[o + 1] = lut[k + 1]
      img.data[o + 2] = lut[k + 2]
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

function animating(): boolean {
  return props.demo && !props.bins && !prefersReducedMotion()
}

function tick(): void {
  pushRow((x, w) => demoLevel(x, w, phase))
  phase += 0.08
  timer = window.setTimeout(() => {
    raf = requestAnimationFrame(tick)
  }, 60)
}

function halt(): void {
  cancelAnimationFrame(raf)
  clearTimeout(timer)
  raf = 0
  timer = 0
}

function restart(): void {
  halt()
  if (props.bins && props.bins.length > 1) fromBins(props.bins)
  else if (props.demo) {
    if (animating()) tick()
    else stillPlaceholder()
  } else surface()
}

onMounted(() => {
  const el = canvas.value
  if (!el) return
  tokens = readTokens(el)
  observer = new ResizeObserver(() => {
    const screen = surface()
    if (screen?.resized && props.demo && !props.bins && !animating()) stillPlaceholder()
  })
  observer.observe(el)
  stopMotion = onReducedMotion(() => restart())
  restart()
})

onBeforeUnmount(() => {
  halt()
  observer?.disconnect()
  observer = null
  stopMotion?.()
  stopMotion = null
})

// A frame arrives as a new array, and each one is exactly one row. The dB
// window travels with the frames, so it must not add a row of its own.
watch(
  () => props.bins,
  (bins) => {
    if (bins && bins.length > 1) {
      halt()
      fromBins(bins)
    } else restart()
  },
)
watch(
  () => [props.demo, props.height],
  () => restart(),
)
// rows already painted keep their colours and their frequencies, so both are wiped.
watch(
  () => [props.view, props.palette],
  () => clearHistory(),
)

const bandLeft = computed(() => toScreen((props.marker ?? 0) + props.band[0]) * 100)
const bandWidth = computed(() => ((props.band[1] - props.band[0]) / viewW.value) * 100)
</script>

<template>
  <div
    ref="shell"
    class="bn-void"
    :style="{ height: height + 'px', touchAction: interactive ? 'pan-y' : undefined, cursor }"
    @pointerdown="handlers.onDown"
    @pointermove="handlers.onMove"
    @pointerup="handlers.onUp"
    @pointercancel="handlers.onCancel"
    @pointerleave="handlers.onLeave"
    @wheel="handlers.onWheel"
  >
    <canvas ref="canvas" style="height: 100%" role="img" aria-label="waterfall history"></canvas>
    <template v-if="marker !== null && marker !== undefined">
      <i class="bn-fall-band" aria-hidden="true" :style="{ left: bandLeft + '%', width: bandWidth + '%' }" />
      <i class="bn-fall-line" aria-hidden="true" :style="{ left: toScreen(marker) * 100 + '%' }" />
    </template>
  </div>
</template>

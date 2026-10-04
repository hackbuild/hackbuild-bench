<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AutoRange,
  HANDLE_PX,
  SLOP,
  demoLevel,
  fitCanvas,
  handleLeft,
  heat,
  markerKeyTarget,
  markerReadout,
  normalise,
  onReducedMotion,
  peakAt,
  peakBetween,
  prefersReducedMotion,
  readTokens,
} from './canvas'
import type { Screen, ScreenTokens } from './canvas'

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
  /** Listening point as a fraction of the width. null draws no marker. */
  marker?: number | null
  /** Passband width as a fraction of the width, centred on the marker. */
  markerWidth?: number
  /** Let a pointer set the listening point. */
  interactive?: boolean
  /** The visible part of the span, as fractions of it. */
  view?: [number, number]
  /** Paint a row for every this many frames, so the history covers more time. */
  rowEvery?: number
}

const props = withDefaults(defineProps<Props>(), {
  height: 120,
  minDb: -100,
  maxDb: -10,
  auto: true,
  demo: false,
  marker: null,
  markerWidth: 0,
  interactive: false,
  view: () => [0, 1] as [number, number],
  rowEvery: 1,
})

const emit = defineEmits<{
  tune: [fraction: number]
  step: [dir: number]
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

const pointers = new Map<number, number>()
let pinchFrom = 0

function screenAt(clientX: number): number {
  const el = canvas.value ?? shell.value
  if (!el) return 0.5
  const r = el.getBoundingClientRect()
  if (r.width <= 0) return 0.5
  return Math.max(0, Math.min(1, (clientX - r.left) / r.width))
}

function onWheel(ev: WheelEvent): void {
  if (!props.interactive) return
  const about = toSpan(screenAt(ev.clientX))
  if (ev.ctrlKey || ev.metaKey) emit('zoom', ev.deltaY < 0 ? 1.25 : 0.8, about)
  else if (ev.shiftKey) emit('pan', (ev.deltaY > 0 ? 0.1 : -0.1) * viewW.value)
  else emit('step', ev.deltaY < 0 ? 1 : -1)
  ev.preventDefault()
}

const canvas = ref<HTMLCanvasElement | null>(null)

// the waterfall scrolls its own canvas, so a marker drawn onto it would slide
// down with the history. it sits over the top instead.
const shell = ref<HTMLElement | null>(null)
const handle = ref<HTMLElement | null>(null)
let tuning = false
let downX = 0
let moved = false

/** The spectrum is drawn across the canvas, which is inside the shell border. */
function fractionAt(ev: PointerEvent): number {
  return toSpan(screenAt(ev.clientX))
}

function onDown(ev: PointerEvent): void {
  if (!props.interactive || !shell.value) return
  pointers.set(ev.pointerId, ev.clientX)
  if (pointers.size === 2) {
    // a second finger turns the gesture into a pinch and cancels the tune.
    tuning = false
    const xs = [...pointers.values()]
    pinchFrom = Math.abs(xs[0] - xs[1])
    shell.value.setPointerCapture(ev.pointerId)
    return
  }
  tuning = true
  downX = ev.clientX
  moved = false
  shell.value.setPointerCapture(ev.pointerId)
  ev.preventDefault()
  // the pointer target and the keyboard target are different nodes, and
  // preventDefault suppresses the focus a click would give the one it hit.
  handle.value?.focus({ preventScroll: true })
}

function onMove(ev: PointerEvent): void {
  if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, ev.clientX)
  if (pointers.size === 2) {
    const xs = [...pointers.values()]
    const spread = Math.abs(xs[0] - xs[1])
    if (pinchFrom > 8 && spread > 8 && Math.abs(spread - pinchFrom) > 6) {
      emit('zoom', spread / pinchFrom, toSpan(screenAt((xs[0] + xs[1]) / 2)))
      pinchFrom = spread
    }
    return
  }
  if (!tuning) return
  // a touch that becomes a page scroll must not tune on its way past.
  if (!moved && Math.abs(ev.clientX - downX) <= SLOP) return
  moved = true
  emit('tune', fractionAt(ev))
}

function onUp(ev: PointerEvent): void {
  pointers.delete(ev.pointerId)
  if (!tuning) return
  if (!moved) emit('tune', fractionAt(ev))
  onCancel(ev)
}

function onCancel(ev: PointerEvent): void {
  pointers.delete(ev.pointerId)
  if (!tuning) return
  tuning = false
  const el = shell.value
  if (el?.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
}

/** The canvas hands its role to the slider only when there is a slider. */
const hasHandle = computed(
  () => props.interactive && props.marker !== null && props.marker !== undefined,
)

const markerNow = computed(() => Number((props.marker ?? 0.5).toFixed(3)))

const markerText = computed(() => markerReadout(props.marker, props.markerWidth))

function onKey(ev: KeyboardEvent): void {
  if (ev.shiftKey) return
  const next = markerKeyTarget(ev.key, toScreen(props.marker ?? 0.5))
  if (next === null) return
  emit('tune', toSpan(next))
  ev.preventDefault()
}

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
  for (let x = 0; x < w; x++) {
    const [r, g, b] = heat(level(x, w))
    const o = x * 4
    row.data[o] = r
    row.data[o + 1] = g
    row.data[o + 2] = b
    row.data[o + 3] = 255
  }
  ctx.putImageData(row, 0, 0)
}

let skipped = 0

function fromBins(bins: Float32Array): void {
  const shown = visible(bins)
  const win = props.auto
    ? range.update(shown)
    : { minDb: props.minDb, maxDb: props.maxDb }
  if (++skipped < Math.max(1, props.rowEvery)) return
  skipped = 0
  const full = viewW.value >= 0.999
  pushRow((x, w) => {
    const v = full ? peakAt(bins, x, w) : peakBetween(bins, toSpan(x / w), toSpan((x + 1) / w))
    // the gamma keeps the noise floor dark so carriers read as the signal.
    return normalise(v, win.minDb, win.maxDb) ** 1.9
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

function fromPlaceholder(): void {
  pushRow((x, w) => demoLevel(x, w, phase))
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
  for (let y = 0; y < h; y++) {
    const at = phase + (h - y) * 0.08
    for (let x = 0; x < w; x++) {
      const [r, g, b] = heat(demoLevel(x, w, at))
      const o = (y * w + x) * 4
      img.data[o] = r
      img.data[o + 1] = g
      img.data[o + 2] = b
      img.data[o + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

function animating(): boolean {
  return props.demo && !props.bins && !prefersReducedMotion()
}

function tick(): void {
  fromPlaceholder()
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
watch(
  () => props.view,
  () => clearHistory(),
)
</script>

<template>
  <div
    ref="shell"
    class="bn-void"
    :style="{
      height: height + 'px',
      position: 'relative',
      touchAction: interactive ? 'pan-y' : undefined,
      cursor: interactive ? 'ew-resize' : undefined,
    }"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onCancel"
    @wheel="onWheel"
  >
    <canvas
      ref="canvas"
      style="height: 100%"
      :role="hasHandle ? undefined : 'img'"
      :aria-label="hasHandle ? undefined : 'waterfall history'"
      :aria-hidden="hasHandle ? 'true' : undefined"
    ></canvas>
    <template v-if="marker !== null && marker !== undefined">
      <i
        aria-hidden="true"
        :style="{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: toScreen(marker - (markerWidth ?? 0) / 2) * 100 + '%',
          width: ((markerWidth ?? 0) / viewW) * 100 + '%',
          background: 'var(--hb-pink)',
          opacity: 0.18,
          pointerEvents: 'none',
        }"
      />
      <i
        aria-hidden="true"
        :style="{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: toScreen(marker) * 100 + '%',
          width: '1px',
          background: 'var(--hb-pink)',
          pointerEvents: 'none',
        }"
      />
      <div
        v-if="interactive"
        ref="handle"
        role="slider"
        tabindex="0"
        aria-label="listening point, waterfall"
        :aria-valuemin="0"
        :aria-valuemax="1"
        :aria-valuenow="markerNow"
        :aria-valuetext="markerText"
        :style="{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: handleLeft(Math.min(1, Math.max(0, toScreen(marker)))),
          width: HANDLE_PX + 'px',
          pointerEvents: 'none',
        }"
        @keydown="onKey"
      ></div>
    </template>
  </div>
</template>

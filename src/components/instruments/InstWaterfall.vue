<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AutoRange, demoLevel, fitCanvas, heat, normalise, prefersReducedMotion, readTokens } from './canvas'
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
})

const emit = defineEmits<{ tune: [fraction: number] }>()

// the waterfall scrolls its own canvas, so a marker drawn onto it would slide
// down with the history. it sits over the top instead.
const shell = ref<HTMLElement | null>(null)
let tuning = false

function fractionAt(ev: PointerEvent): number {
  const el = shell.value
  if (!el) return 0.5
  const r = el.getBoundingClientRect()
  if (r.width <= 0) return 0.5
  return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width))
}

function onDown(ev: PointerEvent): void {
  if (!props.interactive || !shell.value) return
  tuning = true
  shell.value.setPointerCapture(ev.pointerId)
  emit('tune', fractionAt(ev))
  ev.preventDefault()
}

function onMove(ev: PointerEvent): void {
  if (tuning) emit('tune', fractionAt(ev))
}

function onUp(ev: PointerEvent): void {
  if (!tuning) return
  tuning = false
  shell.value?.releasePointerCapture(ev.pointerId)
}

const range = new AutoRange()

const canvas = ref<HTMLCanvasElement | null>(null)
let tokens: ScreenTokens | null = null
let raf = 0
let timer = 0
let phase = 0
let observer: ResizeObserver | null = null

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

function fromBins(bins: Float32Array): void {
  const win = props.auto
    ? range.update(bins)
    : { minDb: props.minDb, maxDb: props.maxDb }
  pushRow((x, w) => {
    const i = Math.min(bins.length - 1, Math.floor((x / w) * bins.length))
    // the gamma keeps the noise floor dark so carriers read as the signal.
    return normalise(bins[i], win.minDb, win.maxDb) ** 1.9
  })
}

function fromPlaceholder(): void {
  pushRow((x, w) => demoLevel(x, w, phase))
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
    else fromPlaceholder()
  } else surface()
}

onMounted(() => {
  const el = canvas.value
  if (!el) return
  tokens = readTokens(el)
  observer = new ResizeObserver(() => surface())
  observer.observe(el)
  restart()
})

onBeforeUnmount(() => {
  halt()
  observer?.disconnect()
  observer = null
})

// A frame arrives as a new array. Mutating one in place will not add a row.
watch(
  () => [props.bins, props.demo, props.height, props.minDb, props.maxDb],
  () => restart(),
)
</script>

<template>
  <div
    ref="shell"
    class="bn-void"
    :style="{
      height: height + 'px',
      position: 'relative',
      touchAction: interactive ? 'none' : undefined,
      cursor: interactive ? 'ew-resize' : undefined,
    }"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
  >
    <canvas ref="canvas" style="height: 100%" role="img" aria-label="waterfall history"></canvas>
    <template v-if="marker !== null && marker !== undefined">
      <i
        aria-hidden="true"
        :style="{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: (marker - (markerWidth ?? 0) / 2) * 100 + '%',
          width: (markerWidth ?? 0) * 100 + '%',
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
          left: marker * 100 + '%',
          width: '1px',
          background: 'var(--hb-pink)',
          pointerEvents: 'none',
        }"
      />
    </template>
  </div>
</template>

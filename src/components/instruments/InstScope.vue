<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { AutoRange, fitCanvas, normalise, prefersReducedMotion, readTokens } from './canvas'
import type { ScreenTokens } from './canvas'

interface Props {
  /** dB magnitudes, low bin to high bin. */
  bins: Float32Array | null
  height?: number
  ruled?: boolean
  /** Fixed display window. Ignored unless auto is turned off. */
  minDb?: number
  maxDb?: number
  /** Follow the data instead of using minDb and maxDb. */
  auto?: boolean
  /** Run the placeholder trace while bins is null. */
  demo?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  height: 170,
  ruled: true,
  minDb: -100,
  maxDb: -10,
  auto: true,
  demo: false,
})

const range = new AutoRange()

const canvas = ref<HTMLCanvasElement | null>(null)
let tokens: ScreenTokens | null = null
let raf = 0
let phase = 0
let observer: ResizeObserver | null = null

function graticule(ctx: CanvasRenderingContext2D, w: number, h: number, colour: string): void {
  ctx.save()
  ctx.strokeStyle = colour
  ctx.globalAlpha = 0.18
  ctx.lineWidth = 1
  for (let y = h / 3; y < h - 1; y += h / 3) {
    const line = Math.round(y) + 0.5
    ctx.beginPath()
    ctx.moveTo(0, line)
    ctx.lineTo(w, line)
    ctx.stroke()
  }
  ctx.restore()
}

function traceBins(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bins: Float32Array,
): void {
  const win = props.auto ? range.update(bins) : { minDb: props.minDb, maxDb: props.maxDb }
  ctx.beginPath()
  for (let x = 0; x < w; x++) {
    const i = Math.min(bins.length - 1, Math.floor((x / w) * bins.length))
    const y = h - 2 - normalise(bins[i], win.minDb, win.maxDb) * (h - 4)
    if (x) ctx.lineTo(x, y)
    else ctx.moveTo(x, y)
  }
  ctx.stroke()
}

function tracePlaceholder(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.beginPath()
  for (let x = 0; x < w; x++) {
    let y = h - 5 - 4 * Math.sin(x * 0.03 + phase) - Math.random() * 3
    const peaks = [0.3, 0.52, 0.76]
    for (let i = 0; i < peaks.length; i++) {
      const c = peaks[i] * w
      const width = 10 + i * 4
      y -=
        h *
        0.6 *
        Math.exp(-((x - c) * (x - c)) / (2 * width * width)) *
        (0.7 + 0.3 * Math.sin(phase * 1.4 + i))
    }
    if (x) ctx.lineTo(x, y)
    else ctx.moveTo(x, y)
  }
  ctx.stroke()
}

function draw(): void {
  const el = canvas.value
  if (!el || !tokens) return
  const screen = fitCanvas(el, true)
  if (!screen) return
  const { ctx, w, h } = screen
  ctx.clearRect(0, 0, w, h)
  graticule(ctx, w, h, tokens.dim)
  ctx.strokeStyle = tokens.pink
  ctx.lineWidth = 1.5
  if (props.bins && props.bins.length > 1) traceBins(ctx, w, h, props.bins)
  else if (props.demo) tracePlaceholder(ctx, w, h)
}

function animating(): boolean {
  return props.demo && !props.bins && !prefersReducedMotion()
}

function tick(): void {
  phase += 0.05
  draw()
  raf = requestAnimationFrame(tick)
}

function restart(): void {
  cancelAnimationFrame(raf)
  raf = 0
  draw()
  if (animating()) raf = requestAnimationFrame(tick)
}

onMounted(() => {
  const el = canvas.value
  if (!el) return
  tokens = readTokens(el)
  observer = new ResizeObserver(() => draw())
  observer.observe(el)
  restart()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  observer?.disconnect()
  observer = null
})

// A frame arrives as a new array. Mutating one in place will not repaint.
watch(
  () => [props.bins, props.demo, props.height, props.minDb, props.maxDb],
  () => restart(),
)
</script>

<template>
  <div class="bn-void" :class="{ 'is-ruled': ruled }" :style="{ height: height + 'px' }">
    <canvas ref="canvas" style="height: 100%" role="img" aria-label="spectrum trace"></canvas>
  </div>
</template>

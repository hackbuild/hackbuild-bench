<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  AutoRange,
  HANDLE_PX,
  fitCanvas,
  handleLeft,
  markerKeyTarget,
  normalise,
  onReducedMotion,
  peakAt,
  peakBetween,
  prefersReducedMotion,
  readTokens,
} from './canvas'
import type { ScreenTokens } from './canvas'
import { useTuningPointer } from './useTuningPointer'
import type { Band } from './useTuningPointer'
import { dbTicks } from '@/core/dsp/spectrumMath'
import { paletteLut } from '@/core/palettes'
import type { PaletteName } from '@/core/palettes'
import { formatHz } from '@/core/format'

/** A labelled point on the trace, as a fraction of the whole span. */
export interface ScopeMarker {
  at: number
  label: string
}

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
  /** Listening point as a fraction of the span. null draws no marker. */
  marker?: number | null
  /** The passband around the marker, as fractions of the span measured from it. */
  band?: Band
  /** Text on the flag over the listening point. */
  markerLabel?: string
  /** Let a pointer move the listening point and drag the passband's edges. */
  interactive?: boolean
  /** A click places a pick instead of moving the marker. */
  pickable?: boolean
  /** The visible part of the span, as fractions of it. */
  view?: [number, number]
  /** Edges of the whole span in Hz, for the hover readout. */
  lowHz?: number
  highHz?: number
  /** Max hold and min hold traces, drawn dim under the live one. */
  hold?: Float32Array | null
  floor?: Float32Array | null
  markers?: ScopeMarker[]
  /** Label the dB gridlines. */
  dbAxis?: boolean
  /** Fill under the trace in this colour map, matching the waterfall. */
  palette?: PaletteName | null
}

const props = withDefaults(defineProps<Props>(), {
  height: 170,
  ruled: true,
  minDb: -100,
  maxDb: -10,
  auto: true,
  demo: false,
  marker: null,
  band: () => [0, 0] as Band,
  markerLabel: '',
  interactive: false,
  pickable: false,
  view: () => [0, 1] as [number, number],
  lowHz: 0,
  highHz: 0,
  hold: null,
  floor: null,
  markers: () => [],
  dbAxis: false,
  palette: null,
})

const emit = defineEmits<{
  /** Move the listening point. snap is false while alt is held. */
  tune: [fraction: number, snap: boolean]
  /** New passband width as a fraction of the span. */
  width: [fraction: number]
  pick: [fraction: number]
  /** Tuning steps up or down. fine asks for a tenth of a step. */
  step: [steps: number, fine: boolean]
  /** Zoom by factor about a fraction of the span. */
  zoom: [factor: number, about: number]
  pan: [delta: number]
}>()

const range = new AutoRange()

const canvas = ref<HTMLCanvasElement | null>(null)
const handle = ref<HTMLElement | null>(null)
let tokens: ScreenTokens | null = null
let raf = 0
let phase = 0
let observer: ResizeObserver | null = null
let stopMotion: (() => void) | null = null

const viewLo = computed(() => props.view[0])
const viewW = computed(() => Math.max(1e-6, props.view[1] - props.view[0]))

function toSpan(x: number): number {
  return viewLo.value + x * viewW.value
}
function toScreen(f: number): number {
  return (f - viewLo.value) / viewW.value
}

const pointer = useTuningPointer({
  el: canvas,
  view: () => props.view,
  marker: () => props.marker,
  band: () => props.band,
  role: () => (props.interactive ? 'tune' : props.pickable ? 'pick' : 'none'),
  focus: () => handle.value?.focus({ preventScroll: true }),
  onTune: (f, snap) => emit('tune', f, snap),
  onWidth: (f) => emit('width', f),
  onPick: (f) => emit('pick', f),
  onStep: (n, fine) => emit('step', n, fine),
  onZoom: (factor, about) => emit('zoom', factor, about),
  onPan: (d) => emit('pan', d),
})
const { hoverX, dragging, cursor, handlers } = pointer

/** The bins inside the view, so a zoomed trace spends every column on them. */
function visible(bins: Float32Array): Float32Array {
  const n = bins.length
  const lo = Math.max(0, Math.floor(viewLo.value * n))
  const hi = Math.min(n, Math.max(lo + 2, Math.ceil(props.view[1] * n)))
  return lo === 0 && hi === n ? bins : bins.subarray(lo, hi)
}

function windowFor(bins: Float32Array | null): { minDb: number; maxDb: number } {
  if (!props.auto) return { minDb: props.minDb, maxDb: props.maxDb }
  return bins ? range.update(bins) : { minDb: props.minDb, maxDb: props.maxDb }
}

function graticule(ctx: CanvasRenderingContext2D, w: number, h: number, win: { minDb: number; maxDb: number }): void {
  if (!tokens) return
  ctx.save()
  ctx.strokeStyle = tokens.dim
  ctx.fillStyle = tokens.dim
  ctx.lineWidth = 1
  const ticks = props.dbAxis ? dbTicks(win.minDb, win.maxDb) : []
  if (ticks.length) {
    ctx.font = `13px ${tokens.readout}`
    ctx.textBaseline = 'bottom'
    for (const db of ticks) {
      const y = Math.round(h - 2 - normalise(db, win.minDb, win.maxDb) * (h - 4)) + 0.5
      ctx.globalAlpha = 0.18
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()
      ctx.globalAlpha = 0.9
      ctx.fillText(`${db}`, 4, y - 1)
    }
  } else {
    ctx.globalAlpha = 0.18
    for (let y = h / 3; y < h - 1; y += h / 3) {
      const line = Math.round(y) + 0.5
      ctx.beginPath()
      ctx.moveTo(0, line)
      ctx.lineTo(w, line)
      ctx.stroke()
    }
  }
  ctx.restore()
}

/** The trace's height at each column, in canvas pixels from the top. */
function traceYs(w: number, h: number, bins: Float32Array, win: { minDb: number; maxDb: number }): Float32Array {
  const full = viewW.value >= 0.999
  const ys = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const v = full ? peakAt(bins, x, w) : peakBetween(bins, toSpan(x / w), toSpan((x + 1) / w))
    ys[x] = h - 2 - normalise(v, win.minDb, win.maxDb) * (h - 4)
  }
  return ys
}

function placeholderYs(w: number, h: number): Float32Array {
  const ys = new Float32Array(w)
  const peaks = [0.3, 0.52, 0.76]
  for (let x = 0; x < w; x++) {
    let y = h - 5 - 4 * Math.sin(x * 0.03 + phase) - Math.random() * 3
    for (let i = 0; i < peaks.length; i++) {
      const c = peaks[i] * w
      const width = 10 + i * 4
      y -= h * 0.6 * Math.exp(-((x - c) * (x - c)) / (2 * width * width)) * (0.7 + 0.3 * Math.sin(phase * 1.4 + i))
    }
    ys[x] = y
  }
  return ys
}

function stroke(ctx: CanvasRenderingContext2D, ys: Float32Array): void {
  ctx.beginPath()
  for (let x = 0; x < ys.length; x++) {
    if (x) ctx.lineTo(x, ys[x])
    else ctx.moveTo(x, ys[x])
  }
  ctx.stroke()
}

/**
 * Fills under the trace in the waterfall's colour map, so a level reads the
 * same colour in both. The colour follows height, which is level.
 */
function fill(ctx: CanvasRenderingContext2D, ys: Float32Array, h: number): void {
  if (!props.palette) return
  const lut = paletteLut(props.palette)
  const grad = ctx.createLinearGradient(0, h, 0, 0)
  for (let i = 0; i <= 8; i++) {
    const k = Math.round((i / 8) * 255) * 3
    grad.addColorStop(i / 8, `rgba(${lut[k]}, ${lut[k + 1]}, ${lut[k + 2]}, ${0.25 + 0.5 * (i / 8)})`)
  }
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(0, h)
  for (let x = 0; x < ys.length; x++) ctx.lineTo(x, ys[x])
  ctx.lineTo(ys.length - 1, h)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()
  ctx.restore()
}

/** The listening point, the passband around it, and its flag. Drawn over the trace. */
function drawMarker(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const m = props.marker
  if (m === null || m === undefined || !tokens) return
  const x = toScreen(m) * w
  const lo = toScreen(m + props.band[0]) * w
  const hi = toScreen(m + props.band[1]) * w
  const active = dragging.value === 'low' || dragging.value === 'high'
  ctx.save()
  ctx.fillStyle = tokens.pink
  ctx.globalAlpha = 0.16
  ctx.fillRect(lo, 0, Math.max(2, hi - lo), h)
  ctx.globalAlpha = active ? 1 : 0.6
  if (props.band[0] < 0) ctx.fillRect(Math.round(lo) - 0.5, 0, 1, h)
  if (props.band[1] > 0) ctx.fillRect(Math.round(hi) - 0.5, 0, 1, h)
  ctx.globalAlpha = 1
  ctx.fillRect(Math.round(x) - 1, 0, 2, h)
  if (props.markerLabel) {
    ctx.font = `15px ${tokens.readout}`
    ctx.textBaseline = 'top'
    const tw = ctx.measureText(props.markerLabel).width + 8
    // the flag hangs off the line on whichever side has room.
    const left = x + tw + 4 < w ? x + 2 : x - tw - 2
    ctx.fillStyle = tokens.screen
    ctx.fillRect(left, 2, tw, 18)
    ctx.fillStyle = tokens.pink
    ctx.fillRect(left, 2, 2, 18)
    ctx.fillStyle = tokens.paper
    ctx.fillText(props.markerLabel, left + 6, 3)
  }
  ctx.restore()
}

/** Measurement markers: a paper tick and its label, so they never read as the trace. */
function drawMarkers(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  if (!tokens || !props.markers.length) return
  ctx.save()
  ctx.font = `600 10px ${tokens.utility}`
  ctx.textBaseline = 'top'
  for (const mk of props.markers) {
    const f = toScreen(mk.at)
    if (f < 0 || f > 1) continue
    const x = Math.round(f * w) + 0.5
    ctx.strokeStyle = tokens.paper
    ctx.globalAlpha = 0.7
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(x, 14)
    ctx.lineTo(x, h)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    ctx.fillStyle = tokens.paper
    const tw = ctx.measureText(mk.label).width
    ctx.fillText(mk.label, Math.min(w - tw - 2, Math.max(2, x - tw / 2)), 1)
  }
  ctx.restore()
}

const hoverText = computed(() => {
  const x = hoverX.value
  if (x === null || !props.bins?.length) return ''
  const f = toSpan(x)
  const n = props.bins.length
  const db = props.bins[Math.min(n - 1, Math.max(0, Math.floor(f * n)))]
  const db1 = Number.isFinite(db) ? `${db.toFixed(1)} dB` : ''
  if (!(props.highHz > props.lowHz)) return db1
  const hz = props.lowHz + f * (props.highHz - props.lowHz)
  return `${formatHz(hz, 4)}  ${db1}`
})

function drawHover(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const x = hoverX.value
  if (x === null || !tokens || dragging.value) return
  ctx.save()
  ctx.strokeStyle = tokens.paper
  ctx.globalAlpha = 0.35
  const px = Math.round(x * w) + 0.5
  ctx.beginPath()
  ctx.moveTo(px, 0)
  ctx.lineTo(px, h)
  ctx.stroke()
  ctx.restore()
}

function draw(): void {
  const el = canvas.value
  if (!el || !tokens) return
  const screen = fitCanvas(el, true)
  if (!screen) return
  const { ctx, w, h } = screen
  ctx.clearRect(0, 0, w, h)
  const live = props.bins && props.bins.length > 1 ? props.bins : null
  const win = windowFor(live ? visible(live) : null)
  graticule(ctx, w, h, win)
  const ys = live ? traceYs(w, h, live, win) : props.demo ? placeholderYs(w, h) : null
  if (ys) fill(ctx, ys, h)
  ctx.lineWidth = 1
  if (props.floor && props.floor.length > 1) {
    ctx.strokeStyle = tokens.dim
    stroke(ctx, traceYs(w, h, props.floor, win))
  }
  if (props.hold && props.hold.length > 1) {
    ctx.strokeStyle = tokens.slime
    ctx.globalAlpha = 0.7
    stroke(ctx, traceYs(w, h, props.hold, win))
    ctx.globalAlpha = 1
  }
  if (ys) {
    ctx.strokeStyle = tokens.pink
    ctx.lineWidth = 1.5
    stroke(ctx, ys)
  }
  drawMarker(ctx, w, h)
  drawMarkers(ctx, w, h)
  drawHover(ctx, w, h)
}

/**
 * The canvas hands its role to a slider when there is something to move: the
 * listening point on a tuning trace, the first marker on a measuring one.
 */
const hasHandle = computed(
  () => (props.interactive && props.marker !== null && props.marker !== undefined) || props.pickable,
)

/** Where the keyboard handle sits, as a fraction of the span. */
const handleAt = computed(() => (props.interactive ? (props.marker ?? 0.5) : (props.markers[0]?.at ?? toSpan(0.5))))

const markerNow = computed(() => Number(handleAt.value.toFixed(3)))

const markerText = computed(() => {
  if (!props.interactive) {
    const at = props.markers[0]?.at
    if (at === undefined) return 'no marker placed. arrows place one.'
    if (!(props.highHz > props.lowHz)) return `marker ${(at * 100).toFixed(1)}% across`
    return `marker at ${formatHz(props.lowHz + at * (props.highHz - props.lowHz), 4)}`
  }
  if (props.markerLabel) return `listening at ${props.markerLabel}`
  return `listening ${((props.marker ?? 0.5) * 100).toFixed(1)}% across the window`
})

/**
 * Keys on a tuning trace: arrows step, shift with them steps finely, page up
 * and down step ten, the square brackets narrow and widen the passband, home
 * goes back to the centre, plus and minus zoom.
 */
function onKey(ev: KeyboardEvent): void {
  const zoomAbout = props.interactive ? (props.marker ?? 0.5) : handleAt.value
  if (ev.key === '+' || ev.key === '=') emit('zoom', 1.5, zoomAbout)
  else if (ev.key === '-' || ev.key === '_') emit('zoom', 1 / 1.5, zoomAbout)
  else if (!props.interactive) {
    const next = markerKeyTarget(ev.key, toScreen(handleAt.value))
    if (next === null) return
    emit('pick', toSpan(next))
  } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') emit('step', 1, ev.shiftKey)
  else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') emit('step', -1, ev.shiftKey)
  else if (ev.key === 'PageUp') emit('step', 10, false)
  else if (ev.key === 'PageDown') emit('step', -10, false)
  else if (ev.key === '[' || ev.key === ']') {
    const width = props.band[1] - props.band[0]
    emit('width', width * (ev.key === ']' ? 1.25 : 0.8))
  } else if (ev.key === 'Home') emit('tune', 0.5, false)
  else return
  ev.preventDefault()
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
  stopMotion = onReducedMotion(() => restart())
  restart()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  observer?.disconnect()
  observer = null
  stopMotion?.()
  stopMotion = null
})

// A frame arrives as a new array. Mutating one in place will not repaint.
watch(
  () => [
    props.bins,
    props.demo,
    props.height,
    props.minDb,
    props.maxDb,
    props.marker,
    props.band,
    props.markerLabel,
    props.view,
    props.hold,
    props.floor,
    props.markers,
    props.palette,
    hoverX.value,
    dragging.value,
  ],
  () => {
    if (!raf) draw()
  },
)
watch(
  () => [props.demo, props.bins === null],
  () => restart(),
)

watch(
  () => props.view,
  () => range.reset(),
)
</script>

<template>
  <div class="bn-void" :class="{ 'is-ruled': ruled }" :style="{ height: height + 'px' }">
    <canvas
      ref="canvas"
      style="height: 100%"
      :style="{ touchAction: interactive || pickable ? 'pan-y' : undefined, cursor }"
      :role="hasHandle ? undefined : 'img'"
      :aria-label="hasHandle ? undefined : 'spectrum trace'"
      :aria-hidden="hasHandle ? 'true' : undefined"
      @pointerdown="handlers.onDown"
      @pointermove="handlers.onMove"
      @pointerup="handlers.onUp"
      @pointercancel="handlers.onCancel"
      @pointerleave="handlers.onLeave"
      @wheel="handlers.onWheel"
    ></canvas>
    <span v-if="hoverText" class="bn-hover" aria-hidden="true">{{ hoverText }}</span>
    <div
      v-if="hasHandle"
      ref="handle"
      role="slider"
      tabindex="0"
      :aria-label="interactive ? 'listening point, spectrum' : 'measurement marker, spectrum'"
      :aria-keyshortcuts="interactive ? 'ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight PageUp PageDown [ ] Home + -' : 'ArrowLeft ArrowRight Home End + -'"
      :aria-valuemin="0"
      :aria-valuemax="1"
      :aria-valuenow="markerNow"
      :aria-valuetext="markerText"
      :style="{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: handleLeft(Math.min(1, Math.max(0, toScreen(handleAt)))),
        width: HANDLE_PX + 'px',
        pointerEvents: 'none',
      }"
      @keydown="onKey"
    ></div>
  </div>
</template>

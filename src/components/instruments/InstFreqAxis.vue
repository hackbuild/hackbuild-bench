<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { frequencyTicks, tickUnit } from '@/core/dsp/spectrumMath'

interface Props {
  /** Edges of the whole span in Hz. */
  lowHz: number
  highHz: number
  /** The visible part of the span, as fractions of it. */
  view?: [number, number]
  /** Short ticks along the top edge, as fractions of the whole span. */
  marks?: number[]
}

const props = withDefaults(defineProps<Props>(), {
  view: () => [0, 1] as [number, number],
  marks: () => [],
})

const emit = defineEmits<{
  pan: [delta: number]
  zoom: [factor: number, about: number]
}>()

const el = ref<HTMLElement | null>(null)
const width = ref(0)
let observer: ResizeObserver | null = null

const shownLow = computed(() => props.lowHz + props.view[0] * (props.highHz - props.lowHz))
const shownHigh = computed(() => props.lowHz + props.view[1] * (props.highHz - props.lowHz))

/** The unit label holds the right edge, so a tick that would run under it is dropped. */
const UNIT_PX = 70

const ticks = computed(() =>
  frequencyTicks(shownLow.value, shownHigh.value, width.value).filter(
    (t) => t.at * width.value < width.value - UNIT_PX,
  ),
)
const unit = computed(() => tickUnit(shownLow.value, shownHigh.value))

const zoomed = computed(() => props.view[1] - props.view[0] < 0.999)

const markAt = computed(() =>
  props.marks
    .map((m) => (m - props.view[0]) / (props.view[1] - props.view[0]))
    .filter((f) => f >= 0 && f <= 1),
)

let dragFrom: number | null = null

function onDown(ev: PointerEvent): void {
  if (!zoomed.value || !el.value) return
  dragFrom = ev.clientX
  el.value.setPointerCapture(ev.pointerId)
}

function onMove(ev: PointerEvent): void {
  if (dragFrom === null || !el.value) return
  const w = el.value.getBoundingClientRect().width
  if (w <= 0) return
  // dragging right pulls the lower frequencies into view.
  emit('pan', (-(ev.clientX - dragFrom) / w) * (props.view[1] - props.view[0]))
  dragFrom = ev.clientX
}

function onUp(ev: PointerEvent): void {
  dragFrom = null
  if (el.value?.hasPointerCapture(ev.pointerId)) el.value.releasePointerCapture(ev.pointerId)
}

/** Ctrl or cmd with the wheel zooms and shift pans, as over the trace. A bare wheel scrolls the page. */
function onWheel(ev: WheelEvent): void {
  if (!el.value) return
  const width = props.view[1] - props.view[0]
  if (ev.ctrlKey || ev.metaKey) {
    const r = el.value.getBoundingClientRect()
    const x = r.width > 0 ? (ev.clientX - r.left) / r.width : 0.5
    emit('zoom', ev.deltaY < 0 ? 1.25 : 0.8, props.view[0] + x * width)
  } else if (ev.shiftKey) {
    emit('pan', (ev.deltaY > 0 ? 0.1 : -0.1) * width)
  } else return
  ev.preventDefault()
}

function onKey(ev: KeyboardEvent): void {
  const width = props.view[1] - props.view[0]
  const mid = (props.view[0] + props.view[1]) / 2
  if (ev.key === 'ArrowLeft') emit('pan', -0.1 * width)
  else if (ev.key === 'ArrowRight') emit('pan', 0.1 * width)
  else if (ev.key === '+' || ev.key === '=') emit('zoom', 1.5, mid)
  else if (ev.key === '-' || ev.key === '_') emit('zoom', 1 / 1.5, mid)
  else return
  ev.preventDefault()
}

onMounted(() => {
  if (!el.value) return
  observer = new ResizeObserver(() => {
    width.value = el.value?.clientWidth ?? 0
  })
  observer.observe(el.value)
  width.value = el.value.clientWidth
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div
    ref="el"
    class="bn-axis"
    :class="{ 'is-pan': zoomed }"
    role="group"
    tabindex="0"
    :aria-label="`frequency axis, ${(shownLow / 1e6).toFixed(3)} to ${(shownHigh / 1e6).toFixed(3)} mhz. arrows pan, plus and minus zoom.`"
    aria-keyshortcuts="ArrowLeft ArrowRight + -"
    @keydown="onKey"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @wheel="onWheel"
  >
    <span
      v-for="t in ticks"
      :key="t.hz"
      class="bn-tick"
      :style="{ left: t.at * 100 + '%' }"
    >{{ t.label }}</span>
    <i v-for="(m, i) in markAt" :key="i" class="bn-mark" :style="{ left: m * 100 + '%' }"></i>
    <span class="bn-unit">{{ unit }}</span>
  </div>
</template>

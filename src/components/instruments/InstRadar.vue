<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { fitCanvas, prefersReducedMotion, readTokens } from './canvas'
import type { ScreenTokens } from './canvas'

interface Blip {
  /** Degrees clockwise from north. 0 points up the screen. */
  bearing: number
  /** 0 at the centre, 1 at the outer ring. */
  distance: number
  label: string
}

interface Props {
  blips: Blip[]
  /** What the outer ring means, drawn in the corner. */
  rangeLabel: string
  size?: number
}

const props = withDefaults(defineProps<Props>(), { size: 300 })

const canvas = ref<HTMLCanvasElement | null>(null)
let tokens: ScreenTokens | null = null
let raf = 0
let sweep = 0
let observer: ResizeObserver | null = null

function angleOf(bearing: number): number {
  return ((bearing - 90) * Math.PI) / 180
}

function draw(): void {
  const el = canvas.value
  if (!el || !tokens) return
  const screen = fitCanvas(el, true)
  if (!screen) return
  const { ctx, w, h } = screen
  const cx = w / 2
  const cy = h / 2
  const r = Math.min(w, h) / 2 - 6

  ctx.fillStyle = tokens.screen
  ctx.fillRect(0, 0, w, h)

  ctx.save()
  ctx.strokeStyle = tokens.slime
  ctx.globalAlpha = 0.25
  ctx.lineWidth = 1
  for (let i = 1; i <= 3; i++) {
    ctx.beginPath()
    ctx.arc(cx, cy, (r * i) / 3, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.beginPath()
  ctx.moveTo(cx - r, cy)
  ctx.lineTo(cx + r, cy)
  ctx.moveTo(cx, cy - r)
  ctx.lineTo(cx, cy + r)
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.globalAlpha = 0.18
  ctx.fillStyle = tokens.pink
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.arc(cx, cy, r, sweep - 0.4, sweep)
  ctx.closePath()
  ctx.fill()
  ctx.restore()

  ctx.strokeStyle = tokens.pink
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  ctx.lineTo(cx + Math.cos(sweep) * r, cy + Math.sin(sweep) * r)
  ctx.stroke()

  ctx.font = `12px ${tokens.readout}`
  for (const blip of props.blips) {
    const a = angleOf(blip.bearing)
    const d = Math.max(0, Math.min(1, blip.distance))
    const bx = cx + Math.cos(a) * d * r
    const by = cy + Math.sin(a) * d * r
    let gap = Math.abs((sweep - a) % (Math.PI * 2))
    if (gap > Math.PI) gap = Math.PI * 2 - gap
    const bright = Math.max(0.25, 1 - gap / 1.2)
    ctx.save()
    ctx.globalAlpha = bright
    ctx.fillStyle = tokens.slime
    ctx.fillRect(bx - 3, by - 3, 6, 6)
    if (bright > 0.5) {
      ctx.fillStyle = tokens.paper
      ctx.fillText(blip.label, bx + 6, by + 3)
    }
    ctx.restore()
  }

  if (props.rangeLabel) {
    ctx.fillStyle = tokens.slime
    ctx.fillText(props.rangeLabel, 8, 16)
  }
}

function tick(): void {
  sweep += 0.03
  if (sweep > Math.PI * 2) sweep -= Math.PI * 2
  draw()
  raf = requestAnimationFrame(tick)
}

function restart(): void {
  cancelAnimationFrame(raf)
  raf = 0
  draw()
  if (!prefersReducedMotion()) raf = requestAnimationFrame(tick)
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

watch(() => [props.blips, props.size, props.rangeLabel], () => draw())
</script>

<template>
  <div
    class="bn-void"
    :style="{ width: size + 'px', maxWidth: '100%', aspectRatio: '1 / 1' }"
  >
    <canvas
      ref="canvas"
      style="height: 100%"
      role="img"
      :aria-label="'radar, ' + blips.length + ' contacts, ' + rangeLabel"
    ></canvas>
  </div>
</template>

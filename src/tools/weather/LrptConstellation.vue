<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { readTokens } from '@/components/instruments/canvas'

interface Props {
  /** Interleaved I and Q, scaled so a clean point sits near 1. */
  points: Float32Array | null
  /** Draws the points in the lit colour once the loop holds. */
  locked?: boolean
}

const props = withDefaults(defineProps<Props>(), { locked: false })

const el = ref<HTMLCanvasElement | null>(null)
const SIZE = 160

function draw(): void {
  const c = el.value
  const ctx = c?.getContext('2d')
  if (!c || !ctx) return
  const t = readTokens(c)
  ctx.fillStyle = t.screen
  ctx.fillRect(0, 0, SIZE, SIZE)
  ctx.strokeStyle = t.dim
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(SIZE / 2 + 0.5, 0)
  ctx.lineTo(SIZE / 2 + 0.5, SIZE)
  ctx.moveTo(0, SIZE / 2 + 0.5)
  ctx.lineTo(SIZE, SIZE / 2 + 0.5)
  ctx.stroke()
  const pts = props.points
  if (!pts) return
  ctx.fillStyle = props.locked ? t.slime : t.dim
  const scale = SIZE / 5
  for (let i = 0; i < pts.length; i += 2) {
    const x = SIZE / 2 + pts[i] * scale
    const y = SIZE / 2 - pts[i + 1] * scale
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue
    ctx.fillRect(x - 1, y - 1, 2, 2)
  }
}

watch(() => [props.points, props.locked], draw)
onMounted(draw)
</script>

<template>
  <div class="bn-void bn-iq">
    <canvas
      ref="el"
      :width="SIZE"
      :height="SIZE"
      role="img"
      :aria-label="locked ? 'constellation, four clusters, carrier held' : 'constellation, no carrier held'"
    />
  </div>
</template>

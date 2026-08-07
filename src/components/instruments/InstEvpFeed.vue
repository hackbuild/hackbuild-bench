<script setup lang="ts">
import { computed } from 'vue'
import { isWhisperArtifact } from '@/core/analysis/words'

interface EvpLine {
  text: string
  /** Wall clock ms. */
  at: number
  fromHz?: number
  toHz?: number
  seconds?: number
}

interface Props {
  lines: EvpLine[]
  max?: number
}

const props = withDefaults(defineProps<Props>(), { max: 40 })

function clock(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function mhz(hz: number): string {
  return (hz / 1e6).toFixed(2)
}

function meta(line: EvpLine, filler: boolean): string {
  const parts = [clock(line.at)]
  if (line.fromHz !== undefined && line.toHz !== undefined) {
    parts.push(`${mhz(line.fromHz)} MHz to ${mhz(line.toHz)} MHz`)
  } else if (line.fromHz !== undefined) {
    parts.push(`${mhz(line.fromHz)} MHz`)
  }
  if (line.seconds !== undefined) parts.push(`${line.seconds.toFixed(1)}s`)
  if (filler) parts.push('likely whisper filler')
  return parts.join('  ')
}

interface Row {
  key: string
  text: string
  meta: string
  filler: boolean
}

const rows = computed<Row[]>(() =>
  [...props.lines]
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(0, props.max))
    .map((line, i) => {
      const filler = isWhisperArtifact(line.text)
      return { key: `${line.at}-${i}`, text: line.text, meta: meta(line, filler), filler }
    }),
)
</script>

<template>
  <div>
    <div v-for="row in rows" :key="row.key" class="bn-evp" :class="{ 'is-filler': row.filler }">
      <div>{{ row.text }}</div>
      <div class="bn-evpmeta">{{ row.meta }}</div>
    </div>
    <p v-if="!rows.length" class="bn-note">
      open the box and wait. every few seconds of sweep gets handed to whisper.
    </p>
  </div>
</template>

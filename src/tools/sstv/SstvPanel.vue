<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { SstvDecoder } from '@/core/decode/sstv'
import type { SstvModeSpec, SstvSelect } from '@/core/decode/sstv'
import { SstvDemoSource } from '@/core/decode/demo'
import { useDecodeAudio } from '@/composables/useDecodeAudio'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const PICKS: Array<{ id: SstvSelect; label: string }> = [
  { id: 'auto', label: 'auto' },
  { id: 'robot36', label: 'robot 36' },
  { id: 'martinm1', label: 'martin m1' },
]

const pick = ref<SstvSelect>('auto')
const locked = ref<SstvModeSpec | null>(null)
const rows = ref(0)
const complete = ref(false)
const hasFrame = ref(false)
const canvas = ref<HTMLCanvasElement | null>(null)

const decoder = new SstvDecoder(pick.value)
let frame: ImageData | null = null
let dirty = false
let raf = 0

decoder.onStart = (mode) => {
  locked.value = mode
  complete.value = false
  rows.value = 0
}
decoder.onLine = (e) => {
  frame = e.image
  rows.value = Math.max(rows.value, e.y + 1)
  hasFrame.value = true
  dirty = true
}
decoder.onComplete = (image) => {
  frame = image
  dirty = true
  complete.value = true
}

const audio = useDecodeAudio(props.deviceId, {
  mode: 'usb',
  onAudio: (samples, rate) => decoder.feed(samples, rate),
  demo: () => new SstvDemoSource(pick.value === 'martinm1' ? 'martinm1' : 'robot36'),
  demoSpeed: 8,
})

const height = computed(() => locked.value?.height ?? 0)
const status = computed(() => {
  if (complete.value) return 'frame complete'
  if (locked.value) return `${locked.value.label} locked`
  if (audio.running.value) return pick.value === 'auto' ? 'waiting for a vis header' : 'waiting for a sync pulse'
  return 'idle'
})

function paint(): void {
  raf = requestAnimationFrame(paint)
  if (!dirty || !frame) return
  const el = canvas.value
  if (!el) return
  if (el.width !== frame.width || el.height !== frame.height) {
    el.width = frame.width
    el.height = frame.height
  }
  el.getContext('2d')?.putImageData(frame, 0, 0)
  dirty = false
}

function clear(): void {
  decoder.reset()
  frame = null
  locked.value = null
  rows.value = 0
  complete.value = false
  hasFrame.value = false
  const el = canvas.value
  const ctx = el?.getContext('2d')
  if (el && ctx) ctx.clearRect(0, 0, el.width, el.height)
}

function save(): void {
  const el = canvas.value
  if (!el || !frame) return
  el.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sstv-${locked.value?.id ?? 'frame'}-${Date.now()}.png`
    a.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}

watch(pick, (next) => {
  decoder.setMode(next)
  locked.value = null
  rows.value = 0
  complete.value = false
  hasFrame.value = false
})

onMounted(() => {
  raf = requestAnimationFrame(paint)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
})
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">mode</div>
        <div class="bn-v is-pink">{{ locked?.label ?? pick }}</div>
      </div>
      <div>
        <div class="bn-k">lines</div>
        <div class="bn-v">{{ rows }}<span v-if="height">/{{ height }}</span></div>
      </div>
      <div>
        <div class="bn-k">source</div>
        <div class="bn-v">{{ audio.isSim.value ? 'demo' : 'usb audio' }}</div>
      </div>
      <div>
        <div class="bn-k">state</div>
        <div class="bn-v is-goo">{{ status }}</div>
      </div>
    </div>

    <div class="bn-knobs">
      <div class="bn-knob">
        <span class="bn-klabel">mode</span>
        <div class="bn-seg2">
          <button
            v-for="p in PICKS"
            :key="p.id"
            type="button"
            :aria-pressed="pick === p.id"
            :class="{ 'is-on': pick === p.id }"
            @click="pick = p.id"
          >
            {{ p.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="bn-acts">
      <HbButton v-if="!audio.running.value" variant="danger" size="sm" @click="audio.start()">
        <template #icon><HbIcon name="play" /></template>
        {{ audio.isSim.value ? 'run demo picture' : 'decode' }}
      </HbButton>
      <HbButton v-else size="sm" @click="audio.stop()">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="!hasFrame" @click="save">
        <template #icon><HbIcon name="download" /></template>
        save png
      </HbButton>
      <HbButton size="sm" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
      <HbButton v-if="audio.live.value" size="sm" @click="audio.setMuted(!audio.muted.value)">
        <template #icon><HbIcon name="headphones" /></template>
        {{ audio.muted.value ? 'unmute' : 'mute' }}
      </HbButton>
    </div>

    <p v-if="audio.error.value" class="bn-note">{{ audio.error.value }}</p>

    <div v-if="audio.demoRunning.value" class="bn-prog">
      <i :style="{ width: `${Math.round(audio.demoProgress.value * 100)}%` }" />
    </div>

    <div class="bn-img is-capped" style="margin-top: 10px">
      <canvas ref="canvas" width="320" height="256" aria-label="decoded sstv frame" />
      <span class="bn-imgtag">{{ complete ? 'complete' : 'building' }}</span>
    </div>

    <p v-if="!hasFrame" class="bn-note">
      nothing decoded yet. sstv sends one line at a time, so a picture takes 36 seconds on
      robot 36 and near two minutes on martin m1. a weak or off frequency signal comes out
      slanted or torn rather than not at all.
    </p>

    <div class="bn-hint">
      <HbIcon name="radio" :size="15" />
      <div>
        <b>where to find it</b>
        ham sstv sits at 14.230 and 14.233 MHz on usb, and 144.500 MHz fm on 2 metres. tune
        so the tones land in the middle of the passband, then start the decoder. the pictures
        run in bursts, mostly on weekends and during activity events.
      </div>
    </div>
  </div>
</template>

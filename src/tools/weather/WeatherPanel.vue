<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { AptDecoder, APT_CHANNEL_A, APT_CHANNEL_B } from '@/core/decode/apt'
import { AptDemoSource } from '@/core/decode/demo'
import { useDecodeAudio } from '@/composables/useDecodeAudio'
import { formatDuration } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const rows = ref(0)
const lock = ref(0)
const native = ref(false)
const hasFrame = ref(false)

const full = ref<HTMLCanvasElement | null>(null)
const chanA = ref<HTMLCanvasElement | null>(null)
const chanB = ref<HTMLCanvasElement | null>(null)

const decoder = new AptDecoder({ maxLines: 1200 })
let frame: ImageData | null = null
let dirty = false
let raf = 0

decoder.onLine = (e) => {
  frame = e.image
  rows.value = e.y + 1
  lock.value = decoder.lock
  hasFrame.value = true
  dirty = true
}
decoder.onComplete = (image) => {
  frame = image
  dirty = true
}

const audio = useDecodeAudio(props.deviceId, {
  mode: 'fm',
  onAudio: (samples, rate) => decoder.feed(samples, rate),
  demo: () => new AptDemoSource(240),
  demoSpeed: 20,
})

// two lines a second is the whole reason a pass takes ten minutes.
const elapsed = computed(() => formatDuration((rows.value / 2) * 1000))

// the decoder grows its buffer in blocks, so only the rows it has written are
// drawn. otherwise the canvas carries a black tail through the whole pass.
function drawInto(
  el: HTMLCanvasElement | null,
  image: ImageData,
  offset: number,
  width: number,
  height: number,
): void {
  if (!el || height < 1) return
  if (el.width !== width || el.height !== height) {
    el.width = width
    el.height = height
  }
  el.getContext('2d')?.putImageData(image, -offset, 0, offset, 0, width, height)
}

function paint(): void {
  raf = requestAnimationFrame(paint)
  if (!dirty || !frame) return
  const h = Math.min(rows.value, frame.height)
  drawInto(full.value, frame, 0, frame.width, h)
  drawInto(chanA.value, frame, APT_CHANNEL_A.offset, APT_CHANNEL_A.width, h)
  drawInto(chanB.value, frame, APT_CHANNEL_B.offset, APT_CHANNEL_B.width, h)
  dirty = false
}

function clear(): void {
  decoder.reset()
  frame = null
  rows.value = 0
  lock.value = 0
  hasFrame.value = false
  for (const el of [full.value, chanA.value, chanB.value]) {
    el?.getContext('2d')?.clearRect(0, 0, el.width, el.height)
  }
}

function save(): void {
  const el = full.value
  if (!el || !hasFrame.value) return
  el.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `apt-pass-${Date.now()}.png`
    a.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}

async function end(): Promise<void> {
  await audio.stop()
  decoder.finish()
}

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
        <div class="bn-k">lines</div>
        <div class="bn-v is-pink">{{ rows }}</div>
      </div>
      <div>
        <div class="bn-k">pass</div>
        <div class="bn-v">{{ elapsed }}</div>
      </div>
      <div>
        <div class="bn-k">sync</div>
        <div class="bn-v is-goo">{{ lock > 0.18 ? 'locked' : 'searching' }}</div>
      </div>
      <div>
        <div class="bn-k">source</div>
        <div class="bn-v">{{ audio.isSim.value ? 'demo' : 'fm audio' }}</div>
      </div>
    </div>

    <div class="bn-acts">
      <HbButton v-if="!audio.running.value" variant="danger" size="sm" @click="audio.start()">
        <template #icon><HbIcon name="play" /></template>
        {{ audio.isSim.value ? 'run demo pass' : 'decode pass' }}
      </HbButton>
      <HbButton v-else size="sm" @click="end">
        <template #icon><HbIcon name="stop" /></template>
        end pass
      </HbButton>
      <HbButton size="sm" :disabled="!hasFrame" @click="save">
        <template #icon><HbIcon name="download" /></template>
        save png
      </HbButton>
      <HbButton size="sm" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
      <HbButton size="sm" :aria-pressed="native" @click="native = !native">
        <template #icon><HbIcon name="magnifying-glass-location" /></template>
        {{ native ? 'fit width' : 'native size' }}
      </HbButton>
    </div>

    <p v-if="audio.error.value" class="bn-note">{{ audio.error.value }}</p>

    <div v-if="audio.demoRunning.value" class="bn-prog">
      <i :style="{ width: `${Math.round(audio.demoProgress.value * 100)}%` }" />
    </div>

    <div class="bn-img" :class="{ 'is-native': native }" style="margin-top: 10px">
      <canvas ref="full" width="2080" height="16" aria-label="full apt frame" />
      <span class="bn-imgtag">both channels, 2080 words a line</span>
    </div>

    <div class="bn-imgrow">
      <div class="bn-img">
        <canvas ref="chanA" width="909" height="16" aria-label="apt channel a" />
        <span class="bn-imgtag">channel a</span>
      </div>
      <div class="bn-img">
        <canvas ref="chanB" width="909" height="16" aria-label="apt channel b" />
        <span class="bn-imgtag">channel b</span>
      </div>
    </div>

    <p v-if="!hasFrame" class="bn-note">
      nothing decoded yet. the decoder needs the 7 pulse sync train at the start of each line
      before it will place one, so noise alone produces no picture.
    </p>

    <div class="bn-hint">
      <HbIcon name="satellite" :size="15" />
      <div>
        <b>what a real pass takes</b>
        noaa 15, 18, and 19 send apt on 137.100, 137.9125, and 137.100 MHz, wide fm. you need
        the satellite above the horizon and an antenna that can see it, normally a turnstile
        or a v dipole, since a whip on a desk gets you noise. the picture builds through the
        whole pass at two lines a second, so around 1200 lines over ten minutes, and it fades
        out as the bird sets. channel a is usually visible light, channel b infrared.
      </div>
    </div>

    <div v-if="audio.isSim.value" class="bn-hint">
      <HbIcon name="flask" :size="15" />
      <div>
        <b>demo</b>
        this device is simulated, so the panel synthesises a 2400 Hz subcarrier with real sync
        trains and telemetry wedges and runs it through the same decoder. it plays at twenty
        times real time, which is why the pass finishes in seconds.
      </div>
    </div>
  </div>
</template>

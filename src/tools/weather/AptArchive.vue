<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { AptDecoder, APT_CHANNEL_A, APT_CHANNEL_B } from '@/core/decode/apt'
import { AptDemoSource } from '@/core/decode/demo'
import { formatDuration } from '@/core/format'

const rows = ref(0)
const lock = ref(0)
const native = ref(false)
const hasFrame = ref(false)
const busy = ref(false)
const progress = ref(0)
const error = ref<string | null>(null)
const source = ref('')

const full = ref<HTMLCanvasElement | null>(null)
const chanA = ref<HTMLCanvasElement | null>(null)
const chanB = ref<HTMLCanvasElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const decoder = new AptDecoder({ maxLines: 2400 })
let frame: ImageData | null = null
let dirty = false
let raf = 0
let cancel = false

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

// two lines a second is why a pass took ten minutes.
const elapsed = computed(() => formatDuration((rows.value / 2) * 1000))

// the decoder grows its buffer in blocks, so only the rows it has written are
// drawn. otherwise the canvas carries a black tail through the whole pass.
function drawInto(el: HTMLCanvasElement | null, image: ImageData, offset: number, width: number, height: number): void {
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
  progress.value = 0
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
    a.download = `apt-archive-${Date.now()}.png`
    a.click()
    URL.revokeObjectURL(url)
  }, 'image/png')
}

/** Feeds audio in slices so the picture grows and the page stays responsive. */
async function run(samples: Float32Array, rate: number): Promise<void> {
  const slice = rate * 2
  for (let i = 0; i < samples.length && !cancel; i += slice) {
    decoder.feed(samples.subarray(i, Math.min(samples.length, i + slice)), rate)
    progress.value = Math.min(1, (i + slice) / samples.length)
    await new Promise((r) => setTimeout(r, 0))
  }
  decoder.finish()
}

async function openFile(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  error.value = null
  clear()
  busy.value = true
  cancel = false
  source.value = file.name
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100)
    const audio = await ctx.decodeAudioData(await file.arrayBuffer())
    await run(audio.getChannelData(0), audio.sampleRate)
  } catch (err) {
    error.value = `that file did not decode as audio: ${(err instanceof Error ? err.message : String(err)).toLowerCase()}`
  } finally {
    busy.value = false
  }
}

async function demo(): Promise<void> {
  clear()
  busy.value = true
  cancel = false
  source.value = 'demo'
  const src = new AptDemoSource(240)
  while (!src.done && !cancel) {
    const block = src.read(4000)
    if (block.length) decoder.feed(block, src.sampleRate)
    progress.value = src.progress
    await new Promise((r) => setTimeout(r, 30))
  }
  decoder.finish()
  busy.value = false
}

onMounted(() => {
  raf = requestAnimationFrame(paint)
})

onBeforeUnmount(() => {
  cancel = true
  cancelAnimationFrame(raf)
})
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">lines</div>
        <div class="bn-v">{{ rows }}</div>
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
        <div class="bn-v">{{ source || 'none' }}</div>
      </div>
    </div>

    <div class="bn-acts">
      <HbButton v-if="!busy" variant="danger" size="sm" @click="fileInput?.click()">
        <template #icon><HbIcon name="upload" /></template>
        open apt recording
      </HbButton>
      <HbButton v-else size="sm" @click="cancel = true">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="busy" @click="demo">
        <template #icon><HbIcon name="flask" /></template>
        run demo pass
      </HbButton>
      <HbButton size="sm" :disabled="!hasFrame" @click="save">
        <template #icon><HbIcon name="download" /></template>
        save png
      </HbButton>
      <HbButton size="sm" :disabled="busy" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
      <HbButton size="sm" :aria-pressed="native" @click="native = !native">
        <template #icon><HbIcon name="magnifying-glass-location" /></template>
        {{ native ? 'fit width' : 'native size' }}
      </HbButton>
      <input
        ref="fileInput"
        class="bn-hidden"
        type="file"
        accept="audio/*,.wav,.mp3,.flac,.ogg"
        aria-label="apt audio recording"
        @change="openFile"
      />
    </div>

    <p v-if="error" class="bn-note">{{ error }}</p>

    <div v-if="busy" class="bn-prog">
      <i :style="{ width: `${Math.round(progress * 100)}%` }" />
    </div>

    <div class="bn-img" :class="{ 'is-native': native }" style="margin-top: 10px">
      <canvas ref="full" width="2080" height="16" role="img" aria-label="full apt frame" />
      <span class="bn-imgtag">both channels, 2080 words a line</span>
    </div>

    <div class="bn-imgrow">
      <div class="bn-img">
        <canvas ref="chanA" width="909" height="16" role="img" aria-label="apt channel a" />
        <span class="bn-imgtag">channel a</span>
      </div>
      <div class="bn-img">
        <canvas ref="chanB" width="909" height="16" role="img" aria-label="apt channel b" />
        <span class="bn-imgtag">channel b</span>
      </div>
    </div>

    <p v-if="!hasFrame" class="bn-note">
      nothing decoded yet. open the fm audio of an old pass, as a wav or anything else this
      browser plays. the decoder needs the 7 pulse sync train at the start of each line before it
      places one, so noise alone produces no picture.
    </p>

    <div class="bn-hint">
      <HbIcon name="satellite" :size="15" />
      <div>
        <b>noaa apt is over</b>
        noaa 15, 18 and 19 were the last satellites sending apt, and all three were shut down in
        2025: noaa 18 on june 6, noaa 19 on august 13, noaa 15 on august 19. nothing on 137 mhz
        sends apt now, so this decodes recordings only. for live pictures use meteor lrpt.
      </div>
    </div>
  </div>
</template>

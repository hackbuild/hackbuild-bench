<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstWordCloud from '@/components/instruments/InstWordCloud.vue'
import InstSweepBar from '@/components/instruments/InstSweepBar.vue'
import InstEvpFeed from '@/components/instruments/InstEvpFeed.vue'
import { useDevices } from '@/stores/devices'
import { useReceiver } from '@/composables/useReceiver'
import { useTranscription } from '@/composables/useTranscription'
import { SpiritBox, SWEEP_BANDS, bandById } from '@/core/audio/spiritbox'
import type { DwellWindow, SweepDirection } from '@/core/audio/spiritbox'
import { ingest } from '@/core/analysis/words'
import type { WordEntry } from '@/core/analysis/words'
import { formatHz } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const rx = useReceiver(props.deviceId)
const ears = useTranscription(props.deviceId)

const bandId = ref('fm')
const direction = ref<SweepDirection>('up')
const dwellMs = ref(120)
const throughEars = ref(true)
const running = ref(false)
const currentHz = ref(0)

const words = ref(new Map<string, WordEntry>())

const band = computed(() => bandById(bandId.value) ?? SWEEP_BANDS[0])

const box = new SpiritBox({
  band: band.value,
  tune: async (hz) => {
    currentHz.value = hz
    await devices.configure(props.deviceId, { centerHz: hz })
  },
  onDwell: (w: DwellWindow) => {
    // tag whatever whisper returns next with the span the sweep just covered.
    ears.tagRange.value = { fromHz: w.lowHz, toHz: w.highHz }
  },
})

const cloud = computed(() =>
  [...words.value.entries()].map(([word, e]) => ({ word, count: e.n, hz: e.hz })),
)

const percent = computed(() => {
  const b = band.value
  const span = b.stopHz - b.startHz
  if (span <= 0) return 0
  return Math.max(0, Math.min(100, ((currentHz.value - b.startHz) / span) * 100))
})

const sweepLabel = computed(() => formatHz(currentHz.value, 1))

watch([bandId, direction, dwellMs], () => {
  box.configure({
    band: band.value,
    startHz: band.value.startHz,
    stopHz: band.value.stopHz,
    stepHz: band.value.stepHz,
    direction: direction.value,
    dwellMs: dwellMs.value,
  })
})

watch(
  () => ears.lines.value.length,
  () => {
    const last = ears.lines.value[ears.lines.value.length - 1]
    if (!last) return
    ingest(words.value, last.text, currentHz.value)
    words.value = new Map(words.value)
  },
)

async function open(): Promise<void> {
  rx.setMode(band.value.mode)
  await rx.start()
  if (throughEars.value && !ears.ready.value) await ears.enable()
  box.configure({
    band: band.value,
    startHz: band.value.startHz,
    stopHz: band.value.stopHz,
    stepHz: band.value.stepHz,
    direction: direction.value,
    dwellMs: dwellMs.value,
  })
  box.start()
  running.value = true
}

async function close(): Promise<void> {
  box.stop()
  running.value = false
  await rx.stop()
}

function clear(): void {
  words.value = new Map()
  ears.clear()
}

function exportCsv(): void {
  const rows = [...words.value.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([w, e]) => `${w},${e.n},${e.hz}`)
  const blob = new Blob([`word,count,last_heard_hz\n${rows.join('\n')}\n`], {
    type: 'text/csv',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'ghostbox-words.csv'
  a.click()
  URL.revokeObjectURL(url)
}

function retune(hz: number): void {
  void devices.configure(props.deviceId, { centerHz: hz })
}

onBeforeUnmount(() => {
  box.stop()
  void rx.stop()
})
</script>

<template>
  <div>
    <div class="bn-knobs" style="margin-top: 0">
      <div class="bn-knob">
        <span class="bn-klabel">band</span>
        <select v-model="bandId">
          <option v-for="b in SWEEP_BANDS" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">direction</span>
        <select v-model="direction">
          <option value="up">up the band</option>
          <option value="down">down the band</option>
          <option value="bounce">bounce</option>
          <option value="random">random</option>
        </select>
      </div>
      <div class="bn-knob" style="min-width: 170px">
        <span class="bn-klabel">sweep <b>{{ dwellMs }} ms</b></span>
        <input v-model.number="dwellMs" type="range" min="40" max="400" step="10" />
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">audio</span>
        <button
          type="button"
          class="bn-toggle"
          :class="{ 'is-on': throughEars }"
          :aria-pressed="throughEars"
          @click="throughEars = !throughEars"
        >
          <span class="bn-sw"><i></i></span>through ears
        </button>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton v-if="!running" variant="danger" size="sm" @click="open">
          <template #icon><HbIcon name="ghost" /></template>
          open the box
        </HbButton>
        <HbButton v-else size="sm" @click="close">
          <template #icon><HbIcon name="stop" /></template>
          close it
        </HbButton>
      </div>
    </div>

    <InstSweepBar :percent="percent" :label="sweepLabel" />

    <div class="bn-subhead">
      what it heard
      <span class="bn-aside">click a word to park the receiver where it was caught</span>
      <span class="bn-grow"></span>
      <button type="button" class="bn-tinyact" @click="exportCsv">csv</button>
      <button type="button" class="bn-tinyact" @click="clear">clear</button>
    </div>

    <InstWordCloud :words="cloud" @pick="retune" />

    <div class="bn-subhead" style="margin-top: 14px">the feed</div>
    <InstEvpFeed :lines="ears.lines.value" />

    <p class="bn-note">
      the receiver sweeps the band and hands every few seconds of audio to whisper. what
      comes back is fragments of whatever stations it crossed. words that keep coming
      back walk to the front of the cloud on their own.
    </p>
  </div>
</template>

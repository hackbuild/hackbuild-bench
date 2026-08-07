<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstScope from '@/components/instruments/InstScope.vue'
import InstWaterfall from '@/components/instruments/InstWaterfall.vue'
import InstSmeter from '@/components/instruments/InstSmeter.vue'
import InstKnob from '@/components/instruments/InstKnob.vue'
import EarsPanel from './EarsPanel.vue'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { useReceiver } from '@/composables/useReceiver'
import { formatHz, formatRate } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'
import type { DemodMode } from '@/core/dsp/demod'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const bench = useBench()
const stream = useDeviceStream(props.deviceId)
const rx = useReceiver(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const streaming = computed(() => node.value?.status === 'streaming')

const BANDS = [
  { label: 'fm', hz: 100.3e6, mode: 'fm' as DemodMode },
  { label: 'am', hz: 1000e3, mode: 'am' as DemodMode },
  { label: 'air band', hz: 124.0e6, mode: 'am' as DemodMode },
  { label: 'weather', hz: 162.55e6, mode: 'nfm' as DemodMode },
  { label: 'ham 2m', hz: 146.52e6, mode: 'nfm' as DemodMode },
  { label: 'noaa sat', hz: 137.1e6, mode: 'fm' as DemodMode },
  { label: '433 junk', hz: 433.92e6, mode: 'nfm' as DemodMode },
]

const DEMODS: DemodMode[] = ['fm', 'nfm', 'am', 'usb', 'lsb', 'raw']

const ROLLS = [
  { hz: 162.55e6, name: 'noaa weather radio', note: 'the calm robotic weather voice, always on' },
  { hz: 146.52e6, name: '2m ham calling', note: 'the national simplex calling frequency' },
  { hz: 433.92e6, name: 'the 433 junk band', note: 'remotes, doorbells, cheap sensors chattering' },
  { hz: 1090e6, name: 'planes overhead', note: 'switch to the sky tab and watch the rings' },
  { hz: 121.5e6, name: 'aircraft guard', note: 'the emergency channel, usually quiet' },
  { hz: 137.1e6, name: 'a weather satellite', note: 'wait for a pass and decode the image' },
  { hz: 88.5e6, name: 'the low end of fm', note: 'community radio lives down here' },
]

const rolling = ref(false)
const found = ref<{ name: string; note: string } | null>(null)

const centerHz = computed({
  get: () => node.value?.params.centerHz ?? 0,
  set: (v: number) => void devices.configure(props.deviceId, { centerHz: v }),
})

const params = computed(() => node.value?.descriptor.params ?? [])

function spec(key: string) {
  return params.value.find((p) => p.key === key)
}

function paramModel(key: string) {
  return computed({
    get: () => node.value?.params[key] ?? spec(key)?.default ?? 0,
    set: (v: number) => void devices.configure(props.deviceId, { [key]: v }),
  })
}

const gain = paramModel('gain')
const volume = paramModel('volume')
const squelch = paramModel('squelch')
const ppm = paramModel('ppm')
const sampleRate = paramModel('sampleRate')

function tune(hz: number): void {
  centerHz.value = hz
}

function nudge(dir: number): void {
  const step = rx.mode.value === 'am' ? 10e3 : 100e3
  tune(centerHz.value + dir * step)
}

function pickBand(b: (typeof BANDS)[number]): void {
  rx.setMode(b.mode)
  tune(b.hz)
}

function roll(): void {
  rolling.value = true
  const pick = ROLLS[Math.floor(Math.random() * ROLLS.length)]
  setTimeout(() => {
    rolling.value = false
    found.value = { name: pick.name, note: pick.note }
    tune(pick.hz)
  }, 500)
}

async function listen(): Promise<void> {
  await rx.start()
}

async function letGo(): Promise<void> {
  await rx.stop()
}

watch(
  () => rx.mode.value,
  (m) => rx.applyMode(m),
)

onBeforeUnmount(() => {
  void rx.stop()
})
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">center</div>
        <div class="bn-v is-pink">{{ formatHz(centerHz) }}</div>
      </div>
      <div>
        <div class="bn-k">rate</div>
        <div class="bn-v">{{ formatRate(sampleRate) }}</div>
      </div>
      <div>
        <div class="bn-k">mode</div>
        <div class="bn-v">{{ rx.mode.value }}</div>
      </div>
      <div>
        <div class="bn-k">gain</div>
        <div class="bn-v is-goo">{{ gain >= 49 ? 'auto' : gain }}</div>
      </div>
      <div>
        <div class="bn-k">sig</div>
        <div class="bn-v">{{ rx.signalDb.value.toFixed(0) }} dB</div>
      </div>
      <div v-if="node?.info.tuner">
        <div class="bn-k">tuner</div>
        <div class="bn-v">{{ node.info.tuner }}</div>
      </div>
      <div v-if="stream.droppedSamples.value">
        <div class="bn-k">dropped</div>
        <div class="bn-v is-goo">{{ stream.droppedSamples.value }}</div>
      </div>
    </div>

    <div v-if="!bench.advanced" class="bn-pills">
      <button
        v-for="b in BANDS"
        :key="b.label"
        type="button"
        class="bn-pill"
        :class="{ 'is-on': Math.abs(centerHz - b.hz) < 1000 }"
        @click="pickBand(b)"
      >
        {{ b.label }}
      </button>
    </div>

    <div class="bn-dial">
      <div class="bn-digits">
        {{ (centerHz / 1e6).toFixed(3) }}<small>MHz</small>
      </div>
      <button class="bn-rbtn" type="button" aria-label="tune down" @click="nudge(-1)">&#9668;</button>
      <button class="bn-rbtn" type="button" aria-label="tune up" @click="nudge(1)">&#9658;</button>
      <button
        class="bn-surprise"
        :class="{ 'is-rolling': rolling }"
        type="button"
        @click="roll"
      >
        <HbIcon name="dice" :size="15" />surprise me
      </button>
      <HbButton v-if="!streaming" variant="danger" size="sm" @click="listen">
        <template #icon><HbIcon name="play" /></template>
        listen
      </HbButton>
      <HbButton v-else size="sm" @click="letGo">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
    </div>

    <div v-if="found" class="bn-found">
      <HbIcon class="bn-fi" name="dice" :size="22" />
      <div class="bn-fx">
        <b>{{ found.name }}</b>
        <div>{{ found.note }}</div>
      </div>
      <HbButton variant="danger" size="sm" @click="listen">
        <template #icon><HbIcon name="play" /></template>
        listen
      </HbButton>
    </div>

    <div class="bn-knobs">
      <div class="bn-knob">
        <span class="bn-klabel">demod</span>
        <div class="bn-seg2">
          <button
            v-for="m in DEMODS"
            :key="m"
            type="button"
            :class="{ 'is-on': rx.mode.value === m }"
            @click="rx.setMode(m)"
          >
            {{ m }}
          </button>
        </div>
      </div>

      <InstKnob v-if="spec('volume')" v-model="volume" :spec="spec('volume')!" />
      <InstKnob v-if="spec('gain')" v-model="gain" :spec="spec('gain')!" />
      <InstKnob
        v-if="bench.advanced && spec('squelch')"
        v-model="squelch"
        :spec="spec('squelch')!"
      />
      <InstKnob
        v-if="bench.advanced && spec('sampleRate')"
        v-model="sampleRate"
        :spec="spec('sampleRate')!"
      />
      <InstKnob v-if="bench.advanced && spec('ppm')" v-model="ppm" :spec="spec('ppm')!" />
    </div>

    <InstSmeter :db="rx.signalDb.value" />

    <InstScope :bins="stream.fft.value" :height="170" ruled :demo="!streaming" />
    <InstWaterfall
      :bins="stream.fft.value"
      :height="120"
      :demo="!streaming"
      style="margin-top: 8px"
    />

    <EarsPanel :device-id="deviceId" />

    <p v-if="!bench.advanced" class="bn-note">
      easy mode keeps the presets and the few knobs that matter. switch to advanced for
      squelch, sample rate, and the tuner correction.
    </p>
  </div>
</template>

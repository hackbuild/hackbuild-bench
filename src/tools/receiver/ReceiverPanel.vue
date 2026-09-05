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
import { isSimKind } from '@/core/drivers/sim/simulate'
import { formatHz, formatRate } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'
import type { ParamSpec } from '@/core/types'
import type { DemodMode } from '@/core/dsp/demod'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const bench = useBench()
const stream = useDeviceStream(props.deviceId)
const rx = useReceiver(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const streaming = computed(() => node.value?.status === 'streaming')
const sim = computed(() => isSimKind(node.value?.kind ?? ''))

/** The window on screen, which is what the marker positions are measured in. */
const span = computed(
  () => rx.windowHz.value || stream.sampleRate.value || node.value?.params.sampleRate || 0,
)

/** Where the marker sits across the display, 0 at the left edge and 1 at the right. */
const marker = computed(() => (span.value ? 0.5 + rx.offsetHz.value / span.value : 0.5))
const markerWidth = computed(() => (span.value ? rx.bandwidthHz.value / span.value : 0))

/** The frequency actually being demodulated, offset included. */
const listeningHz = computed(() => centerHz.value + rx.offsetHz.value)

function tuneTo(fraction: number): void {
  if (!span.value) return
  rx.setOffset((fraction - 0.5) * span.value)
}

function widthTo(fraction: number): void {
  if (!span.value) return
  rx.setBandwidth(fraction * span.value)
}

/** Put the listening point back on the middle of the window. */
function recentre(): void {
  rx.setOffset(0)
}

// the placeholder trace is invented, so real hardware never draws it.
const placeholder = computed(() => !streaming.value && sim.value)

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

const sampleRate = paramModel('sampleRate')

/** Volume is a property of the audio sink, so no driver declares it. */
const VOLUME: ParamSpec = { key: 'volume', label: 'volume', min: 0, max: 100, step: 1, default: 72 }
const volume = ref(VOLUME.default)

// centerHz is the dial, volume belongs to the sink, squelch is read by nothing
// in the receive path, and the transmit gain and the sweep range drive other
// panels rather than this one.
const HIDDEN = ['centerHz', 'volume', 'squelch', 'txvga', 'sweepLowHz', 'sweepHighHz']
/** The receive gain, whatever a given radio calls it. Easy mode shows these. */
const GAINS = ['gain', 'lna', 'vga']

const knobs = computed(() =>
  params.value.filter(
    (p) => !HIDDEN.includes(p.key) && (bench.advanced || GAINS.includes(p.key)),
  ),
)

const gains = computed(() => params.value.filter((p) => GAINS.includes(p.key)))

// the rtl-sdr driver hands the top of the gain range to the tuner's own agc,
// so the number at that end is not the gain the radio is running.
function readout(p: ParamSpec): string {
  const v = node.value?.params[p.key] ?? p.default
  if (p.key === 'gain' && v >= p.max) return 'auto'
  return p.unit ? `${v} ${p.unit}` : `${v}`
}

const centerSpec = computed(() => spec('centerHz'))

function reachable(hz: number): boolean {
  const s = centerSpec.value
  return !s || (hz >= s.min && hz <= s.max)
}

const bands = computed(() => BANDS.filter((b) => reachable(b.hz)))
const unreachable = computed(() => BANDS.filter((b) => !reachable(b.hz)).map((b) => b.label))
const pool = computed(() => ROLLS.filter((r) => reachable(r.hz)))

function tune(hz: number): void {
  const s = centerSpec.value
  centerHz.value = s ? Math.min(s.max, Math.max(s.min, hz)) : hz
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
  if (!pool.value.length) return
  rolling.value = true
  const pick = pool.value[Math.floor(Math.random() * pool.value.length)]
  setTimeout(() => {
    rolling.value = false
    found.value = { name: pick.name, note: pick.note }
    tune(pick.hz)
  }, 500)
}

async function listen(): Promise<void> {
  await rx.start()
  // the sink is built by start(), so the knob's position is applied after it.
  rx.setVolume(volume.value / 100)
}

async function letGo(): Promise<void> {
  await rx.stop()
}

watch(
  () => rx.mode.value,
  (m) => rx.applyMode(m),
)

watch(volume, (v) => rx.setVolume(v / 100))

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
      <div v-for="p in gains" :key="p.key">
        <div class="bn-k">{{ p.label }}</div>
        <div class="bn-v is-goo">{{ readout(p) }}</div>
      </div>
      <div>
        <div class="bn-k">sig</div>
        <div class="bn-v">{{ rx.signalDb.value.toFixed(0) }} dB</div>
      </div>
      <div v-if="span">
        <div class="bn-k">listening</div>
        <div class="bn-v is-pink">{{ formatHz(listeningHz) }}</div>
      </div>
      <div v-if="span">
        <div class="bn-k">width</div>
        <div class="bn-v">{{ formatHz(rx.bandwidthHz.value, 1) }}</div>
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

    <div v-if="!bench.advanced" class="bn-packs" role="group" aria-label="band presets">
      <button
        v-for="b in bands"
        :key="b.label"
        type="button"
        class="bn-pack"
        :class="{ 'is-on': Math.abs(centerHz - b.hz) < 1000 }"
        :aria-pressed="Math.abs(centerHz - b.hz) < 1000"
        @click="pickBand(b)"
      >
        {{ b.label }}
      </button>
    </div>

    <p v-if="!bench.advanced && unreachable.length && centerSpec" class="bn-note" style="margin-top: 0">
      outside what this radio tunes: {{ unreachable.join(', ') }}. it covers
      {{ formatHz(centerSpec.min) }} to {{ formatHz(centerSpec.max) }}.
    </p>

    <div class="bn-dial">
      <div class="bn-digits">
        {{ (centerHz / 1e6).toFixed(3) }}<small>MHz</small>
      </div>
      <button class="bn-rbtn" type="button" aria-label="tune down" @click="nudge(-1)">&#9668;</button>
      <button class="bn-rbtn" type="button" aria-label="tune up" @click="nudge(1)">&#9658;</button>
      <HbButton size="sm" :loading="rolling" :disabled="!pool.length" @click="roll">
        <template #icon><HbIcon name="dice" /></template>
        surprise me
      </HbButton>
      <HbButton v-if="!streaming" variant="danger" size="sm" @click="listen">
        <template #icon><HbIcon name="play" /></template>
        listen
      </HbButton>
      <HbButton v-else size="sm" @click="letGo">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
    </div>

    <p v-if="!pool.length" class="bn-note" style="margin-top: 0">
      surprise me is off: nothing on its list is inside what this radio tunes.
    </p>

    <div v-if="found" class="bn-found">
      <HbIcon class="bn-fi" name="dice" :size="22" />
      <div class="bn-fx">
        <b>{{ found.name }}</b>
        <div>{{ found.note }}</div>
      </div>
      <HbButton size="sm" @click="listen">
        <template #icon><HbIcon name="play" /></template>
        listen
      </HbButton>
    </div>

    <div class="bn-knobs">
      <div class="bn-knob">
        <span class="bn-klabel">demod</span>
        <div class="bn-seg2" role="group" aria-label="demodulator">
          <button
            v-for="m in DEMODS"
            :key="m"
            type="button"
            :class="{ 'is-on': rx.mode.value === m }"
            :aria-pressed="rx.mode.value === m"
            @click="rx.setMode(m)"
          >
            {{ m }}
          </button>
        </div>
      </div>

      <InstKnob v-model="volume" :spec="VOLUME" />
      <InstKnob v-for="p in knobs" :key="p.key" v-model="paramModel(p.key).value" :spec="p" />
    </div>

    <InstSmeter :db="rx.signalDb.value" />

    <p v-if="!streaming && !sim" class="bn-note" style="margin-top: 0">
      idle. nothing is being sampled until you press listen.
    </p>

    <p v-if="span" class="bn-note" style="margin-bottom: 4px">
      click the trace or the waterfall to move where you are listening, drag the edges of
      the lit band to widen or narrow it. the radio stays where it is tuned, this moves
      inside the window it is already receiving.
      <button v-if="rx.offsetHz.value" type="button" class="bn-linkish" @click="recentre">
        back to centre
      </button>
    </p>

    <InstScope
      :bins="stream.fft.value"
      :height="170"
      ruled
      :demo="placeholder"
      :marker="span ? marker : null"
      :marker-width="markerWidth"
      :interactive="!!span"
      @tune="tuneTo"
      @width="widthTo"
    />
    <InstWaterfall
      :bins="stream.fft.value"
      :height="120"
      :demo="placeholder"
      :marker="span ? marker : null"
      :marker-width="markerWidth"
      :interactive="!!span"
      @tune="tuneTo"
      style="margin-top: 8px"
    />

    <EarsPanel :device-id="deviceId" />

    <p v-if="!bench.advanced" class="bn-note">
      easy mode keeps the presets and the few knobs that matter. switch to advanced for
      the sample rate and the rest of what this radio exposes.
    </p>
  </div>
</template>

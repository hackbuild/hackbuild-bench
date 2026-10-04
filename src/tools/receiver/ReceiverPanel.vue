<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { HbButton, HbDial, HbIcon, HbInput, HbSelect } from '@virgilvox/hackbuild-ui'
import InstScope from '@/components/instruments/InstScope.vue'
import InstWaterfall from '@/components/instruments/InstWaterfall.vue'
import InstSmeter from '@/components/instruments/InstSmeter.vue'
import InstKnob from '@/components/instruments/InstKnob.vue'
import InstFreqAxis from '@/components/instruments/InstFreqAxis.vue'
import InstBandStrip from '@/components/instruments/InstBandStrip.vue'
import EarsPanel from './EarsPanel.vue'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { useReceiver } from '@/composables/useReceiver'
import { useSpectrumView } from '@/composables/useSpectrumView'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { formatHz, formatRate } from '@/core/format'
import { BAND_PLAN } from '@/core/bandplan'
import {
  ENBW,
  MEDIAN_TO_MEAN_DB,
  binsIn,
  channelPower,
  nearestReachable,
  noiseFloor,
  parseFrequency,
  reaches,
  snapTo,
} from '@/core/dsp/spectrumMath'
import type { DeviceToolProps } from '@/tools/types'
import type { ParamSpec } from '@/core/types'
import type { DemodMode } from '@/core/dsp/demod'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const bench = useBench()
const stream = useDeviceStream(props.deviceId)
const rx = useReceiver(props.deviceId)
const view = useSpectrumView(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const streaming = computed(() => node.value?.status === 'streaming')
const sim = computed(() => isSimKind(node.value?.kind ?? ''))

const centerHz = computed({
  get: () => node.value?.params.centerHz ?? 0,
  set: (v: number) => void devices.configure(props.deviceId, { centerHz: v }),
})

/** The window on screen, which is what the marker positions are measured in. */
const span = computed(
  () =>
    view.spanHz.value ||
    rx.windowHz.value ||
    stream.sampleRate.value ||
    node.value?.params.sampleRate ||
    0,
)

/**
 * The centre the frames on screen were taken at. Right after a retune, and
 * while idle, the frames still come from the last centre, and the axis has
 * to describe them, not the one just asked for.
 */
const windowCenter = computed(() => (view.bins.value && view.centerHz.value) || centerHz.value)

/** Edges of the window the radio is handing over, for the axis and the readouts. */
const lowHz = computed(() => windowCenter.value - span.value / 2)
const highHz = computed(() => windowCenter.value + span.value / 2)

/** Where the marker sits across the window, 0 at the low edge and 1 at the high. */
const marker = computed(() => (span.value ? 0.5 + rx.offsetHz.value / span.value : 0.5))
const markerWidth = computed(() => (span.value ? rx.bandwidthHz.value / span.value : 0))

/** The frequency actually being demodulated, offset included. */
const listeningHz = computed(() => centerHz.value + rx.offsetHz.value)

const STEPS = [
  { label: '1 kHz', value: 1000 },
  { label: '5 kHz', value: 5000 },
  { label: '6.25 kHz', value: 6250 },
  { label: '8.33 kHz', value: 25000 / 3 },
  { label: '10 kHz', value: 10000 },
  { label: '12.5 kHz', value: 12500 },
  { label: '25 kHz', value: 25000 },
  { label: '50 kHz', value: 50000 },
  { label: '100 kHz', value: 100000 },
  { label: '200 kHz', value: 200000 },
]

/** The step each mode is usually channelised on. */
const MODE_STEP: Record<DemodMode, number> = {
  fm: 100000,
  nfm: 12500,
  am: 10000,
  usb: 1000,
  lsb: 1000,
  raw: 1000,
}

const step = ref<number>(MODE_STEP[rx.mode.value])

const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))

function clampHz(hz: number): number {
  const s = centerSpec.value
  return s ? nearestReachable(s, hz) : hz
}

/**
 * Listens at hz. Inside the window it moves the listening point and leaves
 * the radio alone, past the edge it retunes the radio onto hz.
 */
function goTo(hz: number, edge = 0.45): void {
  const target = clampHz(hz)
  const off = target - centerHz.value
  if (span.value && Math.abs(off) <= span.value * edge) {
    rx.setOffset(off)
    return
  }
  rx.setOffset(0)
  centerHz.value = target
}

/**
 * A click lands inside the window, so it never retunes. Snapping can push a
 * click by the window edge past it, and that one is taken unsnapped.
 */
function tuneTo(fraction: number): void {
  if (!span.value) return
  const hz = lowHz.value + fraction * span.value
  const snapped = snapTo(hz, step.value)
  const target = Math.abs(snapped - centerHz.value) <= span.value / 2 ? snapped : hz
  rx.setOffset(clampHz(target) - centerHz.value)
}

function widthTo(fraction: number): void {
  if (!span.value) return
  rx.setBandwidth(fraction * span.value)
}

/** The next channel on the step grid in that direction, never one past it. */
function stepBy(dir: number): void {
  const here = listeningHz.value
  const near = snapTo(here, step.value)
  const onGrid = Math.abs(near - here) < 1
  const next = onGrid || (dir > 0 ? near < here : near > here) ? near + dir * step.value : near
  goTo(next)
}

/** The dial reads and writes MHz. */
const dialMhz = computed({
  get: () => listeningHz.value / 1e6,
  set: (mhz: number) => goTo(mhz * 1e6),
})
// counted on the value as the dial rounds it, so 99.99996 shows as 100.0000.
const dialDigits = computed(() => {
  const shown = Math.round(dialMhz.value * 1e4) / 1e4
  return Math.max(1, Math.floor(Math.log10(Math.max(1, shown))) + 1)
})

const uid = useId()
const gotoId = `${uid}-goto`
const hintId = `${uid}-hint`
const stepId = `${uid}-step`

const typed = ref('')
const typedBad = ref(false)

function submitTyped(): void {
  const hz = parseFrequency(typed.value)
  if (hz === null) {
    typedBad.value = true
    return
  }
  typedBad.value = false
  typed.value = ''
  goTo(hz)
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
  if (p.topLabel && v >= p.max) return p.topLabel
  if (p.key === 'gain' && v >= p.max) return 'auto'
  const named = p.choiceLabels?.[p.choices?.indexOf(v) ?? -1]
  if (named !== undefined) return named
  return p.unit ? `${v} ${p.unit}` : `${v}`
}

function reachable(hz: number): boolean {
  const s = centerSpec.value
  return !s || reaches(s, hz)
}

const bands = computed(() => BANDS.filter((b) => reachable(b.hz)))
const unreachable = computed(() => BANDS.filter((b) => !reachable(b.hz)).map((b) => b.label))
const pool = computed(() => ROLLS.filter((r) => reachable(r.hz)))

/** Presets name a frequency, so they land on it with the listening point centred. */
function tune(hz: number): void {
  rx.setOffset(0)
  centerHz.value = clampHz(hz)
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

/**
 * Power inside the listening band, and how far it stands over the noise in a
 * band of the same width. A strong station elsewhere in the window does not
 * move it.
 */
const channel = computed(() => {
  const b = view.bins.value
  if (!b || !span.value) return null
  const n = b.length
  const lo = (0.5 + (rx.offsetHz.value - rx.bandwidthHz.value / 2) / span.value) * n
  const hi = (0.5 + (rx.offsetHz.value + rx.bandwidthHz.value / 2) / span.value) * n
  const enbw = ENBW[view.windowKind.value] ?? ENBW.hann
  const db = channelPower(b, lo, hi, enbw)
  // averaged frames have lost the spread the median correction assumes.
  const toMean = view.average.value > 1 ? 0 : MEDIAN_TO_MEAN_DB
  const noise = noiseFloor(b) + toMean + 10 * Math.log10(Math.max(1, binsIn(lo, hi, n)) / enbw)
  return { db, snr: db - noise, noise }
})

const zoomed = computed(() => view.view.value[1] - view.view.value[0] < 0.999)

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
  (m) => {
    rx.applyMode(m)
    step.value = MODE_STEP[m]
  },
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
        <div class="bn-k">tuned</div>
        <div class="bn-v">{{ formatHz(centerHz) }}</div>
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
      <div v-if="channel">
        <div class="bn-k">sig</div>
        <div class="bn-v">{{ channel.db.toFixed(0) }} dB</div>
      </div>
      <div v-if="channel">
        <div class="bn-k">snr</div>
        <div class="bn-v">{{ Math.max(0, channel.snr).toFixed(0) }} dB</div>
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
        :class="{ 'is-on': Math.abs(listeningHz - b.hz) < 1000 }"
        :aria-pressed="Math.abs(listeningHz - b.hz) < 1000"
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
      <div role="group" :aria-label="`listening at ${formatHz(listeningHz, 4)}`">
        <HbDial
          v-model="dialMhz"
          :digits="dialDigits"
          :decimals="4"
          unit="MHz"
          :min="(centerSpec?.min ?? 0) / 1e6"
          :max="(centerSpec?.max ?? 1e12) / 1e6"
        />
      </div>
      <button class="bn-rbtn" type="button" :aria-label="`down one step`" @click="stepBy(-1)">&#9668;</button>
      <button class="bn-rbtn" type="button" :aria-label="`up one step`" @click="stepBy(1)">&#9658;</button>
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

    <form class="bn-goto" @submit.prevent="submitTyped">
      <label class="bn-klabel" :for="gotoId">go to</label>
      <HbInput
        :id="gotoId"
        v-model="typed"
        :invalid="typedBad"
        placeholder="146.52"
        inputmode="decimal"
        autocomplete="off"
        :aria-describedby="hintId"
      />
      <HbButton size="sm" type="submit">go</HbButton>
      <label class="bn-klabel" :for="stepId">step</label>
      <HbSelect :id="stepId" v-model="step" :options="STEPS" />
    </form>
    <p :id="hintId" class="bn-note" style="margin: 4px 0 0">
      <template v-if="typedBad">that is not a frequency. try 146.52, 1090k or 7.2 mhz.</template>
      <template v-else>
        a bare number is mhz. the wheel over the trace moves one step, ctrl and the wheel
        zooms, shift and the wheel pans.
      </template>
    </p>

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

    <InstSmeter
      :db="channel?.db ?? -120"
      :floor-db="channel?.noise ?? -90"
      :ceil-db="(channel?.noise ?? -90) + 50"
    />

    <p v-if="!streaming && !sim" class="bn-note" style="margin-top: 0">
      idle. nothing is being sampled until you press listen.
    </p>

    <p v-if="span" class="bn-note" style="margin-bottom: 4px">
      click the trace or the waterfall to move where you are listening, drag the edges of
      the lit band to widen or narrow it. the radio stays where it is tuned until you step
      past the edge of the window.
      <button v-if="rx.offsetHz.value" type="button" class="bn-linkish" @click="recentre">
        back to centre
      </button>
      <button v-if="zoomed" type="button" class="bn-linkish" @click="view.fit()">
        zoom out
      </button>
    </p>

    <InstScope
      :bins="view.bins.value"
      :height="170"
      ruled
      db-axis
      :auto="false"
      :min-db="view.minDb.value"
      :max-db="view.maxDb.value"
      :demo="placeholder"
      :view="view.view.value"
      :low-hz="lowHz"
      :high-hz="highHz"
      :marker="span ? marker : null"
      :marker-width="markerWidth"
      :interactive="!!span"
      @tune="tuneTo"
      @width="widthTo"
      @step="stepBy"
      @zoom="view.zoom"
      @pan="view.pan"
    />
    <InstFreqAxis
      v-if="span"
      :low-hz="lowHz"
      :high-hz="highHz"
      :view="view.view.value"
      :marks="[marker]"
      @pan="view.pan"
      @zoom="view.zoom"
    />
    <InstBandStrip v-if="span" :low-hz="lowHz" :high-hz="highHz" :view="view.view.value" :bands="BAND_PLAN" />
    <InstWaterfall
      :bins="view.bins.value"
      :height="120"
      :auto="false"
      :min-db="view.minDb.value"
      :max-db="view.maxDb.value"
      :demo="placeholder"
      :view="view.view.value"
      :marker="span ? marker : null"
      :marker-width="markerWidth"
      :interactive="!!span"
      @tune="tuneTo"
      @step="stepBy"
      @zoom="view.zoom"
      @pan="view.pan"
      style="margin-top: 8px"
    />

    <EarsPanel :device-id="deviceId" />

    <p v-if="!bench.advanced" class="bn-note">
      easy mode keeps the presets and the few knobs that matter. switch to advanced for
      the sample rate and the rest of what this radio exposes.
    </p>
  </div>
</template>

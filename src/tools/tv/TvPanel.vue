<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstDfMeter from '@/components/instruments/InstDfMeter.vue'
import InstSweepBar from '@/components/instruments/InstSweepBar.vue'
import AnalogTv from './AnalogTv.vue'
import { bus } from '@/core/bus/DeviceBus'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { fixedWindow, reaches } from '@/core/dsp/spectrumMath'
import {
  CHANNEL_HZ,
  FRAMES_PER_LOOK,
  PILOT_MIN_DB,
  TV_CHANNELS,
  TvLook,
  bandOf,
  classify,
  ppmFromPilots,
  windowCentre,
} from '@/core/decode/atsc'
import type { ChannelLook, ChannelResult, TvChannel } from '@/core/decode/atsc'
import { TvDemoSource } from '@/core/decode/atsc/demo'
import { useDevices } from '@/stores/devices'
import { useStreamLease } from '@/composables/useStreamLease'
import type { Artifact, IqChunk } from '@/core/types'
import { emitArtifact } from '@/tools/emit'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()
const devices = useDevices()
const lease = useStreamLease(props.deviceId)

/** The rate the scan asks for. Under about 1.9 Msps a window no longer holds a pilot and the band beside it. */
const SCAN_RATE = 2_400_000
const MIN_RATE = 1_900_000
/** Chunks dropped after a retune while the pll settles. */
const SETTLE_CHUNKS = 3
/** Transforms per reading while aiming, about six readings a second. */
const AIM_FRAMES = 6

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isSim = computed(() => (node.value ? isSimKind(node.value.kind) : false))
const tuner = computed(() => node.value?.info.tuner ?? '')
const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const rateSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'sampleRate'))
const ppmSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'ppm'))

/** A recording cannot retune, so only the channels inside its window are read. */
const recordingWindow = computed(() => {
  const s = centerSpec.value
  const rate = node.value?.params.sampleRate ?? 0
  return s && fixedWindow(s, rate) ? ([s.min - rate / 2, s.min + rate / 2] as [number, number]) : null
})

/** The highest offered rate at or under the scan rate. */
function scanRate(): number {
  const s = rateSpec.value
  if (!s?.choices?.length) return s ? Math.min(s.max, Math.max(s.min, SCAN_RATE)) : SCAN_RATE
  const under = s.choices.filter((r) => r <= SCAN_RATE)
  return under.length ? Math.max(...under) : Math.min(...s.choices)
}

const rateOk = computed(() => isSim.value || !!recordingWindow.value || scanRate() >= MIN_RATE)

/** Channels this unit can tune to. A recording's are worked out when its first window is read. */
const plan = computed<TvChannel[]>(() => {
  const s = centerSpec.value
  if (!s || isSim.value) return [...TV_CHANNELS]
  return TV_CHANNELS.filter((c) => reaches(s, windowCentre(c)))
})
const skipped = computed(() => (recordingWindow.value || isSim.value ? [] : TV_CHANNELS.filter((c) => !plan.value.includes(c))))

const running = ref(false)
const demo = ref(false)
const stage = ref<'idle' | 'scan' | 'aim'>('idle')
const step = ref(0)
const passes = ref(0)
const error = ref<string | null>(null)
/** The latest reading of every channel looked at, by channel number. */
const latest = shallowRef(new Map<number, ChannelLook>())
const aimed = ref<TvChannel | null>(null)
const aimDb = ref(Number.NaN)
const aimBest = ref(Number.NaN)
const showEmpty = ref(false)
/** Digital stations are found here; an analog picture is shown by its own view. */
const view = ref<'digital' | 'analog'>('digital')

async function switchView(next: 'digital' | 'analog'): Promise<void> {
  if (next === view.value) return
  // each view holds the radio its own way, so the scan lets go first.
  if (running.value) await stop()
  view.value = next
}

const look = new TvLook()
let want = { centerHz: 0, rate: 0 }
let settle = 0
let live = false
let demoSource: TvDemoSource | null = null
let demoTimer = 0
let demoLast = 0

/** A tuner rounds what it is asked for, so a chunk counts when it lands close. */
function isWanted(centerHz: number, rate: number): boolean {
  return Math.abs(centerHz - want.centerHz) < 5_000 && Math.abs(rate - want.rate) < want.rate * 0.01
}

async function retune(centerHz: number, rate: number): Promise<void> {
  look.reset()
  const n = node.value
  if (recordingWindow.value && n && !demo.value) {
    want = { centerHz: n.params.centerHz, rate: n.params.sampleRate }
    settle = 0
    return
  }
  want = { centerHz, rate }
  settle = demo.value ? 0 : SETTLE_CHUNKS
  if (demo.value) return
  try {
    await devices.configure(props.deviceId, { centerHz, sampleRate: rate })
  } catch (err) {
    error.value = err instanceof Error ? err.message.toLowerCase() : String(err)
  }
}

function rate(): number {
  return demo.value ? SCAN_RATE : scanRate()
}

async function beginScan(): Promise<void> {
  stage.value = 'scan'
  aimed.value = null
  step.value = 0
  const first = plan.value[0]
  if (first) await retune(windowCentre(first), rate())
}

async function aim(ch: TvChannel): Promise<void> {
  if (!running.value || recordingWindow.value) return
  stage.value = 'aim'
  aimed.value = ch
  aimDb.value = Number.NaN
  aimBest.value = Number.NaN
  await retune(windowCentre(ch), rate())
}

function store(l: ChannelLook): void {
  const next = new Map(latest.value)
  next.set(l.channel, l)
  latest.value = next
}

/** One reading per station per pass goes on the bus, so automations can watch a station come and go. */
function publishPass(): void {
  if (demo.value) return
  for (const r of results.value) {
    if (r.kind === 'none') continue
    emitArtifact(props.deviceId, {
      kind: 'reading',
      name: `tv rf ${r.channel} ${r.kind === 'atsc 1.0' ? 'pilot' : 'band'}`,
      value: Math.round((r.kind === 'atsc 1.0' ? r.pilotDb : r.overFloorDb) * 10) / 10,
      unit: 'db',
    })
  }
}

function process(iq: Float32Array, centerHz: number, chunkRate: number): void {
  if (!isWanted(centerHz, chunkRate)) return
  if (settle > 0) {
    settle--
    return
  }
  look.feed(iq, centerHz, chunkRate)

  if (stage.value === 'aim') {
    if (look.frames < AIM_FRAMES || !aimed.value) return
    const l = look.look(aimed.value)
    look.reset()
    if (!l) return
    aimDb.value = l.pilotDb
    if (!(aimBest.value >= l.pilotDb)) aimBest.value = l.pilotDb
    return
  }

  if (stage.value !== 'scan' || look.frames < FRAMES_PER_LOOK) return
  if (recordingWindow.value && !demo.value) {
    for (const ch of TV_CHANNELS) {
      const l = look.look(ch)
      if (l) store(l)
    }
    look.reset()
    passes.value++
    publishPass()
    return
  }
  const ch = plan.value[step.value]
  const l = ch ? look.look(ch) : null
  if (l) store(l)
  if (step.value + 1 < plan.value.length) {
    step.value++
  } else {
    step.value = 0
    passes.value++
    publishPass()
  }
  void retune(windowCentre(plan.value[step.value]), chunkRate)
}

const stopBus = bus.onDeviceArtifact(props.deviceId, (a: Artifact) => {
  if (a.kind !== 'iq' || !live) return
  const c = a as IqChunk
  process(c.samples, c.centerHz, c.sampleRate)
})

async function start(): Promise<void> {
  error.value = null
  latest.value = new Map()
  passes.value = 0
  if (isSim.value) {
    demoSource = new TvDemoSource()
    demo.value = true
    running.value = true
    await beginScan()
    demoLast = performance.now()
    // blocks are sized from the clock, so a throttled background tab keeps time.
    demoTimer = window.setInterval(() => {
      const src = demoSource
      if (!src || !want.rate) return
      const now = performance.now()
      const ms = Math.min(200, now - demoLast)
      demoLast = now
      if (ms > 0) process(src.read(ms, want.centerHz, want.rate), want.centerHz, want.rate)
    }, 40)
    return
  }
  if (!rateOk.value || (!recordingWindow.value && !plan.value.length)) return
  const t = lease.begin()
  try {
    running.value = true
    live = true
    await beginScan()
    if (!lease.current(t)) return
    if (!(await lease.stream(t))) return
  } catch (err) {
    if (!lease.current(t)) return
    error.value = err instanceof Error ? err.message.toLowerCase() : String(err)
    await stop()
  }
}

async function stop(): Promise<void> {
  if (demoTimer) window.clearInterval(demoTimer)
  demoTimer = 0
  demoSource = null
  demo.value = false
  live = false
  running.value = false
  stage.value = 'idle'
  aimed.value = null
  want = { centerHz: 0, rate: 0 }
  await lease.release()
}

onBeforeUnmount(() => {
  stopBus()
  void stop()
})

// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

const results = computed<ChannelResult[]>(() =>
  classify([...latest.value.values()]).sort((a, b) => a.channel - b.channel),
)
const found = computed(() => results.value.filter((r) => r.kind !== 'none'))
const rows = computed(() => (showEmpty.value ? results.value : found.value))
const pilots = computed(() => found.value.filter((r) => r.kind === 'atsc 1.0').length)
const wides = computed(() => found.value.filter((r) => r.kind === 'wideband, no pilot').length)

function channelOf(n: number): TvChannel {
  return TV_CHANNELS.find((c) => c.number === n)!
}

function mhz(hz: number, digits = 0): string {
  return (hz / 1e6).toFixed(digits)
}

const currentPpm = computed(() => node.value?.params.ppm ?? 0)
const calibration = computed(() => (demo.value || recordingWindow.value ? null : ppmFromPilots(results.value, currentPpm.value)))
const calibrationDemo = computed(() => (demo.value ? ppmFromPilots(results.value, 0) : null))
const suggestedPpm = computed(() => {
  const c = calibration.value
  // under a ppm off is inside how closely the stations agree, so it is left alone.
  if (!c || !ppmSpec.value || Math.abs(c.ppm - currentPpm.value) < 1) return null
  const p = Math.round(c.ppm)
  return Math.max(ppmSpec.value.min, Math.min(ppmSpec.value.max, p))
})

async function applyPpm(): Promise<void> {
  const p = suggestedPpm.value
  if (p === null) return
  try {
    await devices.configure(props.deviceId, { ppm: p })
  } catch (err) {
    error.value = err instanceof Error ? err.message.toLowerCase() : String(err)
  }
}

const progress = computed(() => {
  if (stage.value !== 'scan' || recordingWindow.value) return 0
  return plan.value.length ? (step.value / plan.value.length) * 100 : 0
})

const progressLabel = computed(() => {
  const ch = plan.value[step.value]
  if (!running.value || !ch) return 'idle'
  return `rf ${ch.number}, ${mhz(ch.lowHz)} to ${mhz(ch.lowHz + CHANNEL_HZ)} mhz`
})

const status = computed(() => {
  if (!running.value) return ''
  if (stage.value === 'aim' && aimed.value) {
    return `holding on rf ${aimed.value.number}. turn or move the antenna and watch the pilot.`
  }
  const w = recordingWindow.value
  if (w && !demo.value) return `reading the recording, ${mhz(w[0], 3)} to ${mhz(w[1], 3)} mhz, ${passes.value} passes so far`
  return `pass ${passes.value + 1}, channel ${step.value + 1} of ${plan.value.length}`
})

const ROW_HEAD = ['rf', 'band', 'mhz', 'what', 'pilot', 'over floor', '']
</script>

<template>
  <div>
    <div class="bn-acts tv-views" role="group" aria-label="what to look for">
      <HbButton size="sm" :aria-pressed="view === 'digital'" @click="switchView('digital')">
        <template #icon><HbIcon name="tower-broadcast" /></template>
        digital stations
      </HbButton>
      <HbButton size="sm" :aria-pressed="view === 'analog'" @click="switchView('analog')">
        <template #icon><HbIcon name="display" /></template>
        analog picture
      </HbButton>
    </div>

    <AnalogTv v-if="view === 'analog'" :device-id="deviceId" />

    <div v-else>
    <div class="bn-meta">
      <div>
        <div class="bn-k">with a pilot</div>
        <div class="bn-v">{{ passes || running ? pilots : '--' }}</div>
      </div>
      <div>
        <div class="bn-k">wideband</div>
        <div class="bn-v">{{ passes || running ? wides : '--' }}</div>
      </div>
      <div>
        <div class="bn-k">passes</div>
        <div class="bn-v">{{ passes }}</div>
      </div>
      <div>
        <div class="bn-k">channels</div>
        <div class="bn-v">{{ recordingWindow ? 'in the file' : plan.length }}</div>
      </div>
      <div>
        <div class="bn-k">source</div>
        <div class="bn-v">{{ isSim ? 'demo' : recordingWindow ? 'recording' : 'iq' }}</div>
      </div>
    </div>

    <div class="bn-acts tv-acts">
      <HbButton v-if="!running" variant="danger" size="sm" :disabled="!isSim && !rateOk" @click="start">
        <template #icon><HbIcon name="play" /></template>
        {{ isSim ? 'run demo scan' : recordingWindow ? 'read this recording' : 'scan the tv band' }}
      </HbButton>
      <HbButton v-else size="sm" @click="stop">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton v-if="stage === 'aim'" size="sm" @click="beginScan">
        <template #icon><HbIcon name="repeat" /></template>
        back to scanning
      </HbButton>
      <HbButton size="sm" :aria-pressed="showEmpty" @click="showEmpty = !showEmpty">
        {{ showEmpty ? 'hide empty channels' : 'show empty channels' }}
      </HbButton>
    </div>

    <div class="tv-live" role="status">
      <p v-if="status" class="bn-note">{{ status }}</p>
    </div>
    <p v-if="error" class="bn-note" role="alert">{{ error }}</p>
    <p v-if="!isSim && !rateOk" class="bn-note" role="alert">
      this unit offers no rate between 1.9 and 2.4 msps, which a window needs to hold a pilot and the
      band beside it.
    </p>
    <p v-if="skipped.length" class="bn-note">
      the {{ tuner ? tuner.toLowerCase() : 'tuner' }} does not reach rf
      {{ skipped.map((c) => c.number).join(', ') }}, so those are skipped.
    </p>

    <InstSweepBar v-if="stage === 'scan' && !recordingWindow" :percent="progress" :label="progressLabel" />

    <template v-if="stage === 'aim' && aimed">
      <h3 class="bn-subhead tv-head">
        aiming at rf {{ aimed.number }}
        <span class="bn-aside">{{ mhz(aimed.lowHz) }} to {{ mhz(aimed.lowHz + CHANNEL_HZ) }} mhz</span>
      </h3>
      <InstDfMeter :rssi="aimDb" :floor-db="0" :ceil-db="50" unit="db" :hunt="false" />
      <div class="bn-reads tv-reads">
        <div class="bn-read">
          <div class="bn-k">pilot now</div>
          <div class="bn-v">{{ Number.isFinite(aimDb) ? `${aimDb.toFixed(1)} db` : '--' }}</div>
        </div>
        <div class="bn-read">
          <div class="bn-k">best so far</div>
          <div class="bn-v">{{ Number.isFinite(aimBest) ? `${aimBest.toFixed(1)} db` : '--' }}</div>
        </div>
        <div class="bn-read">
          <div class="bn-k">a station</div>
          <div class="bn-v">over {{ PILOT_MIN_DB }} db</div>
        </div>
      </div>
      <HbButton size="sm" @click="aimBest = Number.NaN">reset best</HbButton>
    </template>

    <h3 class="bn-subhead tv-head">
      {{ showEmpty ? 'every channel read' : 'stations heard' }}
      <span class="bn-aside">rf channels, not the numbers a tv shows</span>
    </h3>
    <div class="bn-sens" role="table" aria-label="tv channels">
      <div class="bn-sens-row tv-row is-head" role="row">
        <span v-for="h in ROW_HEAD" :key="h" role="columnheader">{{ h || 'aim' }}</span>
      </div>
      <div v-for="r in rows" :key="r.channel" class="bn-sens-row tv-row" role="row">
        <span class="bn-sens-model" role="cell">{{ r.channel }}</span>
        <span role="cell">{{ bandOf(channelOf(r.channel)) }}</span>
        <span class="bn-sens-num" role="cell">{{ mhz(channelOf(r.channel).lowHz) }}</span>
        <span role="cell">{{ r.kind === 'none' ? 'quiet' : r.kind }}</span>
        <span class="bn-sens-num" role="cell">{{ r.pilotDb.toFixed(1) }}</span>
        <span class="bn-sens-num" role="cell">{{ r.overFloorDb.toFixed(1) }}</span>
        <span role="cell">
          <button
            v-if="!recordingWindow"
            type="button"
            class="bn-linkish"
            :disabled="!running"
            :aria-label="`aim at rf ${r.channel}`"
            @click="aim(channelOf(r.channel))"
          >
            aim
          </button>
        </span>
      </div>
      <div v-if="!rows.length" class="bn-sens-row is-empty" role="row">
        <span role="cell">{{ running ? 'nothing found yet. the first pass takes a few seconds.' : 'press scan to fill this table.' }}</span>
      </div>
    </div>

    <template v-if="calibration || calibrationDemo">
      <h3 class="bn-subhead tv-head">
        crystal check
        <span class="bn-aside">stations hold their pilots within a few hundred hz</span>
      </h3>
      <p v-if="calibration" class="bn-note tv-cal">
        {{ calibration.stations }} stations put this radio {{ (calibration.ppm - currentPpm).toFixed(1) }} ppm
        from where it is set, so the ppm that corrects it is {{ calibration.ppm.toFixed(1) }}. the stations
        agree within {{ calibration.spread.toFixed(1) }} ppm.
        <button v-if="suggestedPpm !== null && suggestedPpm !== currentPpm" type="button" class="bn-linkish" @click="applyPpm">
          set ppm to {{ suggestedPpm }}
        </button>
      </p>
      <p v-else-if="calibrationDemo" class="bn-note tv-cal">
        the demo radio reads {{ calibrationDemo.ppm.toFixed(1) }} ppm off, measured on
        {{ calibrationDemo.stations }} stations. a real radio can be corrected from here.
      </p>
    </template>

    <div class="bn-hint">
      <HbIcon name="display" :size="15" />
      <div>
        <b>what it does</b>
        steps through every us tv channel and looks for the pilot each atsc 1.0 station carries
        309 khz above its lower edge. the pilot stands far over the noise, so a station shows here
        well before its picture would be watchable. atsc 3.0 has no pilot and shows as a raised
        band. the picture itself cannot be decoded: a channel is 6 mhz wide and this radio takes
        in under 3. a station's rf channel is not the number on the tv, which is sent inside the
        signal. rabbitears.info lists which station uses which rf channel near you. if most
        channels light up, lower the gain: a strong station overloads the radio.
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
.tv-views {
  margin-bottom: var(--hb-s3);
}
.tv-acts {
  margin-top: var(--hb-s3);
}
.tv-head {
  margin-top: var(--hb-s4);
}
.tv-reads {
  margin: var(--hb-s3) 0;
}
.tv-row {
  grid-template-columns:
    minmax(28px, 0.5fr) minmax(0, 1fr) minmax(0, 0.7fr) minmax(0, 1.6fr) minmax(0, 0.8fr)
    minmax(0, 0.9fr) minmax(0, 0.6fr);
}
.tv-cal {
  margin-top: 0;
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { HbButton, HbIcon, HbSelect } from '@virgilvox/hackbuild-ui'
import InstPulseTrain from '@/components/instruments/InstPulseTrain.vue'
import { bus } from '@/core/bus/DeviceBus'
import { IsmDecoder } from '@/core/decode/ism/decoder'
import type { IsmDecoded, IsmUnknown } from '@/core/decode/ism/decoder'
import { IsmDemoSource } from '@/core/decode/ism/demo'
import { SensorTable } from '@/core/decode/ism/sensors'
import type { SensorEntry } from '@/core/decode/ism/sensors'
import { cToF } from '@/core/decode/ism/readings'
import { clusterWidths, guessCoding } from '@/core/decode/ism/analyze'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { fixedWindow, nearestReachable, reaches, spansOf } from '@/core/dsp/spectrumMath'
import { ChannelFilter } from '@/core/dsp/channel'
import { useStreamLease } from '@/composables/useStreamLease'
import { formatClock, formatHz, formatRate } from '@/core/format'
import type { Artifact, IqChunk } from '@/core/types'
import { useDevices } from '@/stores/devices'
import type { DeviceToolProps } from '@/tools/types'
import { emitArtifact } from '@/tools/emit'

const props = defineProps<DeviceToolProps>()
const devices = useDevices()
const lease = useStreamLease(props.deviceId)
const ids = { band: useId(), rate: useId(), gain: useId() }

interface Band {
  id: string
  hz: number
  label: string
  what: string
  rate: number
}

const BANDS: Band[] = [
  { id: '433', hz: 433.92e6, label: '433.92 mhz', what: 'weather stations, probes, doorbells, remotes, eu tire sensors', rate: 250000 },
  { id: '315', hz: 315e6, label: '315 mhz', what: 'us key fobs and tire pressure sensors', rate: 250000 },
  { id: '915', hz: 915e6, label: '915 mhz', what: 'us ism weather sensors', rate: 1024000 },
]
const RATES = [250000, 1024000]
const MAX_UNKNOWN = 30
const STALL_MS = 3000
/** How far inside a recording's edge a band has to sit to be heard. */
const RECORDING_GUARD_HZ = 40_000
/** The widest a sensor's signal is taken to be either side of its band, for the filter on a recording. */
const CHANNEL_HALF_HZ = 100_000
/** The rate a band is cut down to from a recording. */
const CHANNEL_RATE = 250_000

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isSim = computed(() => (node.value ? isSimKind(node.value.kind) : false))
const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const rateSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'sampleRate'))
const gainSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'gain'))
const tunerName = computed(() => (node.value?.info.tuner ?? node.value?.descriptor.name ?? 'radio').toLowerCase())

const bandId = ref('433')
const rate = ref(250000)
const gain = ref<number | null>(null)

const band = computed(() => BANDS.find((b) => b.id === bandId.value) ?? BANDS[0])

/** A recording cannot retune, so a band has to sit inside the window it holds. */
const recordingWindow = computed(() => {
  const s = centerSpec.value
  return s ? fixedWindow(s, node.value?.params.sampleRate ?? 0, RECORDING_GUARD_HZ) : null
})

function reachable(hz: number): boolean {
  const w = recordingWindow.value
  if (w) return hz >= w[0] && hz <= w[1]
  const s = centerSpec.value
  return !s || reaches(s, hz)
}

function spansText(): string {
  const s = centerSpec.value
  if (!s) return ''
  return spansOf(s)
    .map(([lo, hi]) => `${+(lo / 1e6).toFixed(1)} to ${+(hi / 1e6).toFixed(1)}`)
    .join(' and ')
}

const reachNote = computed(() => {
  if (isSim.value || reachable(band.value.hz)) return null
  const w = recordingWindow.value
  if (w) {
    return `this recording holds ${(w[0] / 1e6).toFixed(3)} to ${(w[1] / 1e6).toFixed(3)} mhz, which leaves out ${band.value.label}.`
  }
  const near = centerSpec.value ? nearestReachable(centerSpec.value, band.value.hz) : 0
  return `no ${band.value.label} on this unit. the ${tunerName.value} tuner covers ${spansText()} mhz, and the closest it gets is ${formatHz(near)}.`.toLowerCase()
})

/** The rate asked for, or the nearest the radio offers at or above it. */
const tuneRate = computed(() => {
  if (recordingWindow.value) return node.value?.params.sampleRate ?? rate.value
  const choices = rateSpec.value?.choices
  if (!choices?.length || choices.includes(rate.value)) return rate.value
  return choices.find((c) => c >= rate.value) ?? choices[choices.length - 1]
})

const gainOptions = computed(() => {
  const s = gainSpec.value
  if (!s) return []
  const out: Array<{ value: number; label: string }> = []
  if (s.topLabel) out.push({ value: s.max, label: s.topLabel })
  const top = s.topLabel ? s.max - 1 : s.max
  for (let g = top; g >= s.min; g -= 5) out.push({ value: g, label: `${g} db` })
  return out
})

watch(
  gainSpec,
  (s) => {
    if (s && gain.value === null) gain.value = s.default
  },
  { immediate: true },
)

watch(bandId, () => {
  rate.value = band.value.rate
})

// a recording opens on a band it holds, when it holds one.
watch(
  recordingWindow,
  (w) => {
    if (!w || reachable(band.value.hz)) return
    const inside = BANDS.find((b) => reachable(b.hz))
    if (inside) bandId.value = inside.id
  },
  { immediate: true },
)

const bandOptions = computed(() =>
  BANDS.map((b) => {
    const out = !isSim.value && !reachable(b.hz)
    return { value: b.id, label: `${b.label}${out ? ' (out of range)' : ''}`, disabled: out }
  }),
)
const rateOptions = RATES.map((r) => ({ value: r, label: formatRate(r).toLowerCase() }))

// ---- decoding ---------------------------------------------------------------

const decoder = new IsmDecoder()
const table = new SensorTable()
const sensors = shallowRef<SensorEntry[]>([])
const unknown = shallowRef<IsmUnknown[]>([])
const messages = ref(0)
const bursts = ref(0)
const noiseDb = ref(-42)
const levelDb = ref(-42)
const lastIq = ref(0)
const heardCenter = ref(0)
const heardRate = ref(0)
const startedAt = ref(0)
const now = ref(Date.now())

const live = ref(false)
const demoOn = ref(false)
const running = computed(() => live.value || demoOn.value)
const error = ref<string | null>(null)
let demo: IsmDemoSource | null = null
/** Set on a recording whose centre is off the band, to bring the band to zero. */
let channel: ChannelFilter | null = null
let channelOut = new Float32Array(0)
/** What the decoder is told the centre is, the band itself when a recording is cut down to it. */
let feedCenterHz = 0
let demoTimer = 0
let clock = 0

decoder.onMessage = (m) => onMessage(m)
decoder.onUnknown = (u) => {
  unknown.value = [u, ...unknown.value].slice(0, MAX_UNKNOWN)
}

function sensorLabel(e: { model: string; fields: Record<string, unknown> }): string {
  const ch = e.fields.channel
  return `${e.model} ${e.fields.id ?? ''}${ch !== undefined ? ` ch ${ch}` : ''}`.trim()
}

function summaryOf(m: IsmDecoded): string {
  const parts: string[] = []
  const f = m.fields
  if (typeof f.temperature_C === 'number') parts.push(`${f.temperature_C.toFixed(1)} °c`)
  if (typeof f.temperature_F === 'number') parts.push(`${f.temperature_F.toFixed(1)} °f`)
  if (typeof f.humidity === 'number') parts.push(`${f.humidity} %`)
  if (typeof f.cmd === 'number') parts.push(`cmd ${f.cmd}`)
  if (typeof f.pressure_kPa === 'number') parts.push(`${f.pressure_kPa} kpa`)
  if (typeof f.pressure_PSI === 'number') parts.push(`${f.pressure_PSI} psi`)
  return `${sensorLabel(m)} ${parts.join(' ')}`.trim()
}

function onMessage(m: IsmDecoded): void {
  const at = Date.now()
  const { fresh, readings } = table.ingest(m, at)
  if (!fresh) return
  messages.value++
  sensors.value = table.list()
  // demo traffic stays in the panel, so the session log and automations see only real air.
  if (demoOn.value) return
  emitArtifact(props.deviceId, {
    kind: 'packet',
    proto: 'ism',
    bytes: m.bytes,
    rssi: Math.round(m.rssiDb * 10) / 10,
    fields: { model: m.model, protocol: m.protocol, ...m.fields, snr_db: Math.round(m.snrDb * 10) / 10 },
    summary: summaryOf(m),
  })
  const who = sensorLabel(m)
  for (const r of readings) {
    emitArtifact(props.deviceId, { kind: 'reading', name: `${who} ${r.key}`, value: Math.round(r.value * 100) / 100, unit: r.unit })
  }
}

function sync(): void {
  bursts.value = decoder.stats.bursts
  noiseDb.value = decoder.noiseDb
  levelDb.value = decoder.levelDb
}

const stopBus = bus.onDeviceArtifact(props.deviceId, (a: Artifact) => {
  if (a.kind !== 'iq' || !live.value) return
  const c = a as IqChunk
  if (channel) feedChannel(c)
  else decoder.feed(c.samples, c.sampleRate, c.centerHz)
  lastIq.value = performance.now()
  heardCenter.value = c.centerHz
  heardRate.value = c.sampleRate
})

function feedChannel(c: IqChunk): void {
  const ch = channel
  if (!ch) return
  const n = c.samples.length >> 1
  const need = Math.ceil(n / ch.decim) * 2 + 2
  if (channelOut.length < need) channelOut = new Float32Array(need)
  let k = 0
  for (let i = 0; i < n; i++) {
    if (!ch.push(c.samples[2 * i], c.samples[2 * i + 1])) continue
    channelOut[k++] = ch.outI
    channelOut[k++] = ch.outQ
  }
  if (k) decoder.feed(channelOut.subarray(0, k), ch.outRate, feedCenterHz)
}

/** On a recording centred off the band, a filter that brings the band to zero and cuts it down. */
function channelFor(centerHz: number, sampleRate: number): ChannelFilter | null {
  if (!recordingWindow.value) return null
  const offset = band.value.hz - centerHz
  if (Math.abs(offset) < 1000 && sampleRate <= 2 * CHANNEL_RATE) return null
  const half = Math.max(RECORDING_GUARD_HZ, Math.min(CHANNEL_HALF_HZ, sampleRate / 2 - Math.abs(offset)))
  return new ChannelFilter(offset, sampleRate, half, Math.min(sampleRate, CHANNEL_RATE))
}

function stopDemo(): void {
  if (demoTimer) clearInterval(demoTimer)
  demoTimer = 0
  demo = null
  demoOn.value = false
}

function startDemo(): void {
  demo = new IsmDemoSource()
  decoder.reset()
  heardCenter.value = demo.centerHz
  heardRate.value = demo.sampleRate
  demoOn.value = true
  let last = performance.now()
  // sized from the clock, so a throttled background tab still runs in real time.
  demoTimer = window.setInterval(() => {
    const src = demo
    if (!src) return
    const t = performance.now()
    const ms = Math.min(2000, t - last)
    last = t
    if (ms <= 0) return
    decoder.feed(src.read(ms), src.sampleRate, src.centerHz)
    lastIq.value = t
  }, 100)
}

async function start(): Promise<void> {
  error.value = null
  startedAt.value = performance.now()
  if (isSim.value) {
    startDemo()
    return
  }
  if (reachNote.value) {
    error.value = reachNote.value
    return
  }
  const n = node.value
  if (!n) {
    error.value = 'this radio is no longer connected'
    return
  }
  const t = lease.begin()
  const window_ = recordingWindow.value
  const center = window_ && centerSpec.value ? centerSpec.value.min : band.value.hz
  const params: Record<string, number> = { centerHz: center, sampleRate: tuneRate.value }
  if (gainSpec.value && gain.value !== null) params.gain = gain.value
  decoder.reset()
  channel = channelFor(center, tuneRate.value)
  feedCenterHz = band.value.hz
  try {
    await devices.configure(props.deviceId, params)
  } catch (err) {
    if (!lease.current(t)) return
    error.value = `the radio refused the tune: ${err instanceof Error ? err.message : String(err)}`
    void lease.release()
    return
  }
  if (!lease.current(t)) return
  const after = devices.nodes.find((x) => x.id === props.deviceId)
  if (after?.error) {
    error.value = `the radio refused the tune: ${after.error}`
    void lease.release()
    return
  }
  live.value = true
  try {
    await lease.stream(t)
  } catch (err) {
    if (!lease.current(t)) return
    live.value = false
    error.value = err instanceof Error ? err.message : String(err)
    void lease.release()
  }
}

async function stop(): Promise<void> {
  stopDemo()
  const was = live.value
  live.value = false
  if (was) decoder.flush()
  channel = null
  await lease.release()
}

function clear(): void {
  table.clear()
  sensors.value = []
  unknown.value = []
  messages.value = 0
}

clock = window.setInterval(() => {
  now.value = Date.now()
  if (running.value) sync()
  const before = table.size
  table.prune(now.value)
  if (table.size !== before) sensors.value = table.list()
}, 1000)

onBeforeUnmount(() => {
  stopBus()
  clearInterval(clock)
  void stop()
})

// ---- what to say ------------------------------------------------------------

const stalled = computed(() => live.value && now.value > 0 && performance.now() - Math.max(lastIq.value, startedAt.value) > STALL_MS)

const status = computed(() => {
  if (!running.value) return null
  if (stalled.value) return 'no samples from the radio for three seconds. check it is still plugged in and that no other tab holds it.'
  const waited = (performance.now() - startedAt.value) / 1000
  void now.value
  if (bursts.value === 0 && waited > 20) {
    return 'no bursts above the noise floor yet. sensors send every 15 to 60 seconds, so give it two minutes. no antenna, or one cut for another band, looks the same.'
  }
  if (bursts.value > 0 && messages.value === 0 && waited > 20) {
    return `${bursts.value} bursts heard and none decoded. the raw view below shows their timings. a weak signal decodes as noise, so move closer or raise the gain.`
  }
  if (messages.value === 0) return 'nothing decoded yet.'
  return null
})

const listening = computed(() => {
  if (!running.value) return ''
  const hz = (v: number) => formatHz(v).toLowerCase()
  const sps = (v: number) => formatRate(v).toLowerCase()
  if (demoOn.value) return `demo traffic at ${hz(heardCenter.value)}, ${sps(heardRate.value)}`
  if (!heardCenter.value) return `tuning to ${hz(band.value.hz)}`
  if (channel) return `listening on ${hz(band.value.hz)}, cut from a recording at ${hz(heardCenter.value)} and ${sps(heardRate.value)}`
  const moved = Math.abs(heardCenter.value - band.value.hz) > 1000 && !recordingWindow.value
  return `listening on ${hz(heardCenter.value)} at ${sps(heardRate.value)}${moved ? ', which another tool retuned' : ''}`
})

// ---- table cells ------------------------------------------------------------

function ago(t: number): string {
  const s = Math.max(0, Math.round((now.value - t) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  return formatClock(t)
}

function temp(e: SensorEntry): string {
  const r = e.readings.temperature
  if (!r) return ''
  return `${r.value.toFixed(1)} °c ${cToF(r.value).toFixed(1)} °f`
}

function wind(e: SensorEntry): string {
  const w = e.readings.wind
  const g = e.readings.gust
  const d = e.readings.wind_dir
  if (!w && !g) return ''
  const parts: string[] = []
  if (w) parts.push(`${w.value.toFixed(1)} km/h`)
  if (g) parts.push(`gust ${g.value.toFixed(1)}`)
  if (d) parts.push(`${Math.round(d.value)}°`)
  return parts.join(' ')
}

function pressure(e: SensorEntry): string {
  const p = e.readings.pressure
  if (!p) return ''
  return `${p.unit === 'kPa' ? p.value.toFixed(1) : Math.round(p.value)} ${p.unit.toLowerCase()}`
}

function battery(e: SensorEntry): string {
  const b = e.readings.battery
  if (!b) return ''
  return b.value ? 'ok' : 'low'
}

function other(e: SensorEntry): string {
  const f = e.fields
  const parts: string[] = []
  if (f.cmd !== undefined) parts.push(`cmd ${f.cmd}`)
  if (f.tristate !== undefined) parts.push(String(f.tristate))
  if (f.uvi !== undefined) parts.push(`uvi ${f.uvi}`)
  if (f.light_lux !== undefined) parts.push(`${f.light_lux} lux`)
  if (f.flags !== undefined) parts.push(`flags ${f.flags}`)
  if (f.status !== undefined) parts.push(`status ${f.status}`)
  return parts.join(' ')
}

const rows = computed(() =>
  sensors.value.map((e) => ({
    key: e.key,
    model: e.model,
    id: String(e.id ?? ''),
    ch: e.channel === undefined ? '' : String(e.channel),
    temp: temp(e),
    hum: e.readings.humidity ? `${Math.round(e.readings.humidity.value)} %` : '',
    wind: wind(e),
    rain: e.readings.rain ? `${e.readings.rain.value.toFixed(1)} mm` : '',
    batt: battery(e),
    press: pressure(e),
    other: other(e),
    seen: ago(e.lastSeen),
    count: e.count,
  })),
)

const unknownRows = computed(() =>
  unknown.value.map((u) => {
    const pc = clusterWidths(u.pulsesUs)
    const gc = clusterWidths(u.gapsUs.slice(0, -1))
    return {
      u,
      pulses: pc.map((c) => `${c.us}x${c.count}`).join(' '),
      gaps: gc.map((c) => `${c.us}x${c.count}`).join(' '),
      guess: guessCoding(pc, gc),
      timings: u.pulsesUs
        .slice(0, 24)
        .map((p, i) => `${p}/${u.gapsUs[i]}`)
        .join(' '),
    }
  }),
)

const ROW_HEAD = ['sensor', 'id', 'ch', 'temperature', 'humidity', 'wind', 'rain', 'battery', 'pressure', 'seen', 'count']
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">sensors</div>
        <div class="bn-v">{{ sensors.length }}</div>
      </div>
      <div>
        <div class="bn-k">decoded</div>
        <div class="bn-v">{{ messages }}</div>
      </div>
      <div>
        <div class="bn-k">bursts</div>
        <div class="bn-v">{{ bursts }}</div>
      </div>
      <div>
        <div class="bn-k">unknown</div>
        <div class="bn-v is-goo">{{ unknown.length }}</div>
      </div>
      <div>
        <div class="bn-k">noise floor</div>
        <div class="bn-v">{{ running ? `${noiseDb.toFixed(1)} db` : '' }}</div>
      </div>
      <div>
        <div class="bn-k">source</div>
        <div class="bn-v">{{ isSim ? 'demo' : tunerName }}</div>
      </div>
    </div>

    <div class="bn-knobs ism-knobs">
      <div class="bn-knob">
        <label :for="ids.band">band</label>
        <HbSelect
          :id="ids.band"
          :model-value="bandId"
          :options="bandOptions"
          :disabled="running"
          @update:model-value="(v: string | number) => (bandId = String(v))"
        />
      </div>
      <div class="bn-knob">
        <label :for="ids.rate">sample rate</label>
        <HbSelect
          :id="ids.rate"
          :model-value="rate"
          :options="rateOptions"
          :disabled="running || Boolean(recordingWindow)"
          @update:model-value="(v: string | number) => (rate = Number(v))"
        />
      </div>
      <div v-if="gainOptions.length" class="bn-knob">
        <label :for="ids.gain">gain</label>
        <HbSelect
          :id="ids.gain"
          :model-value="gain ?? ''"
          :options="gainOptions"
          :disabled="running"
          @update:model-value="(v: string | number) => (gain = Number(v))"
        />
      </div>
    </div>

    <p class="bn-note ism-what">{{ band.what }}.</p>

    <div class="bn-acts">
      <HbButton v-if="!running" variant="danger" size="sm" :disabled="!!reachNote" @click="start">
        <template #icon><HbIcon name="play" /></template>
        {{ isSim ? 'run demo traffic' : `listen on ${band.label}` }}
      </HbButton>
      <HbButton v-else size="sm" @click="stop">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="!sensors.length && !unknown.length" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
    </div>

    <p v-if="reachNote" class="bn-note" role="alert">{{ reachNote }}</p>
    <p v-if="error && error !== reachNote" class="bn-note" role="alert">{{ error }}</p>
    <div aria-live="polite">
      <p v-if="listening" class="bn-note">{{ listening }}</p>
      <p v-if="status" class="bn-note">{{ status }}</p>
    </div>
    <p v-if="!isSim && recordingWindow" class="bn-note">
      a recording plays at the rate it was taken, {{ formatRate(tuneRate).toLowerCase() }}. the decoder times pulses in
      microseconds and does not mind.
    </p>
    <p v-else-if="!isSim && tuneRate !== rate" class="bn-note">
      this radio has no {{ formatRate(rate).toLowerCase() }}, so it runs at {{ formatRate(tuneRate).toLowerCase() }}. the
      decoder times pulses in microseconds and does not mind.
    </p>

    <h3 class="bn-subhead ism-head">sensors heard</h3>
    <div class="bn-sens" role="table" aria-label="sensors heard">
      <div class="bn-sens-row is-head" role="row">
        <span v-for="h in ROW_HEAD" :key="h" role="columnheader">{{ h }}</span>
        <span role="columnheader" class="ism-hidden">code</span>
      </div>
      <div v-for="r in rows" :key="r.key" class="bn-sens-row" role="row">
        <span class="bn-sens-model" role="cell" data-k="sensor">{{ r.model }}</span>
        <span role="cell" data-k="id">{{ r.id }}</span>
        <span role="cell" data-k="ch">{{ r.ch }}</span>
        <span class="bn-sens-num" role="cell" data-k="temperature">{{ r.temp }}</span>
        <span class="bn-sens-num" role="cell" data-k="humidity">{{ r.hum }}</span>
        <span class="bn-sens-num" role="cell" data-k="wind">{{ r.wind }}</span>
        <span class="bn-sens-num" role="cell" data-k="rain">{{ r.rain }}</span>
        <span role="cell" data-k="battery" :class="{ 'is-low': r.batt === 'low' }">{{ r.batt }}</span>
        <span class="bn-sens-num" role="cell" data-k="pressure">{{ r.press }}</span>
        <span class="bn-sens-num" role="cell" data-k="seen">{{ r.seen }}</span>
        <span class="bn-sens-num" role="cell" data-k="count">{{ r.count }}</span>
        <span v-if="r.other" class="bn-sens-other" role="cell" data-k="code">{{ r.other }}</span>
      </div>
      <div v-if="!rows.length" class="bn-sens-row is-empty" role="row">
        <span role="cell">{{ running ? 'nothing decoded yet' : 'start listening to fill this table' }}</span>
      </div>
    </div>

    <h3 class="bn-subhead ism-head">
      bursts nothing decoded
      <span class="bn-aside">pulse and gap widths in microseconds, newest first</span>
    </h3>
    <div class="bn-raw" role="list" aria-label="undecoded bursts">
      <div v-for="r in unknownRows" :key="r.u.id" class="bn-raw-row" role="listitem">
        <div class="bn-raw-head">
          <span>{{ r.u.mod }}</span>
          <span>{{ r.u.count }} pulses</span>
          <span>{{ r.u.snrDb.toFixed(1) }} db snr</span>
          <span>{{ (r.u.offsetHz / 1000).toFixed(1) }} khz off</span>
          <span>looks {{ r.guess }}</span>
        </div>
        <InstPulseTrain :pulses="r.u.pulsesUs" :gaps="r.u.gapsUs" :label="`${r.u.mod} burst of ${r.u.count} pulses`" />
        <div class="bn-raw-k">pulses {{ r.pulses }} gaps {{ r.gaps }}</div>
        <div class="bn-raw-t">{{ r.timings }}</div>
      </div>
      <div v-if="!unknownRows.length" class="bn-raw-row is-empty" role="listitem">
        every burst so far decoded, or none have arrived
      </div>
    </div>

    <div class="bn-hint">
      <HbIcon name="temperature-half" :size="15" />
      <div>
        <b>what this hears</b>
        acurite 592txr, 5-in-1, 3-in-1, 515 and 899. lacrosse tx141 family. ambient weather
        f007th. fine offset wh2, wh5, wh24, wh65b, wh25 and wh32. oregon scientific v2.1 and v3
        temperature, humidity, wind, rain and uv sensors. nexus and prologue. pt2262 and ev1527
        remotes. schrader and toyota tire sensors. the decoders are ports of rtl_433, which is
        gpl-2.0.
      </div>
    </div>

    <div v-if="isSim" class="bn-hint">
      <HbIcon name="flask" :size="15" />
      <div>
        <b>demo</b>
        this device is simulated, so the panel builds real frames for an acurite tower, a
        lacrosse tx141th, a fine offset wh24 on fsk and an ev1527 remote, keys them onto a
        noisy carrier, and runs the result through the same decoder in real time. one burst in
        six is made up and lands in the raw view.
      </div>
    </div>
  </div>
</template>

<style scoped>
.ism-knobs {
  margin-top: 0;
}
.ism-what {
  margin: 0 0 var(--hb-s3);
}
.ism-head {
  margin-top: var(--hb-s4);
}
/* named for assistive tech only, since the code cell spans the whole row under the others. */
.ism-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>

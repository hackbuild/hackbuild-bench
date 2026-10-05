<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId } from 'vue'
import { HbButton, HbConsole, HbIcon, HbTable } from '@virgilvox/hackbuild-ui'
import type { HbConsoleLine, HbTableColumn } from '@virgilvox/hackbuild-ui'
import InstRadar from '@/components/instruments/InstRadar.vue'
import { bus } from '@/core/bus/DeviceBus'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { fixedWindow, reaches } from '@/core/dsp/spectrumMath'
import { bearingDeg, distanceKm } from '@/core/decode/aprs'
import { AIS_CENTER_HZ, AisReceiver, aisChannelsIn } from '@/core/decode/ais/receiver'
import type { AisChannelId, AisFrame } from '@/core/decode/ais/receiver'
import { describeAis, parseAis, shipTypeName } from '@/core/decode/ais/message'
import { toNmea } from '@/core/decode/ais/nmea'
import { Fleet } from '@/core/decode/ais/fleet'
import type { Vessel } from '@/core/decode/ais/fleet'
import { AisDemoSource } from '@/core/decode/ais/demo'
import { formatClock, formatHz } from '@/core/format'
import { useDevices } from '@/stores/devices'
import { useStreamLease } from '@/composables/useStreamLease'
import type { Artifact, IqChunk } from '@/core/types'
import { emitArtifact } from '@/tools/emit'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()
const devices = useDevices()
const lease = useStreamLease(props.deviceId)
const uid = useId()

const HOME_KEY = 'bench.ais.home'
/** Where the demo harbour sits when you have not set a location. */
const DEMO_HOME = { lat: 33.74, lon: -118.26 }
/** The rate the panel asks for. It decimates by eight to the 192 ksps first stage. */
const WANT_RATE = 1_536_000
const RANGES_KM = [10, 25, 50, 100, 200, 400]
const QUIET_MS = 90_000
const MAX_LINES = 300
const AGE_OUT_MS = 30 * 60_000

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isSim = computed(() => (node.value ? isSimKind(node.value.kind) : false))
const tuner = computed(() => node.value?.info.tuner ?? '')
const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const rateSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'sampleRate'))
const gainSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'gain'))
/** A recording cannot retune, so it is decoded where it sits when it holds a channel. */
const recording = computed(() => {
  const s = centerSpec.value
  const rate = node.value?.params.sampleRate ?? 0
  return s && fixedWindow(s, rate) ? { centerHz: s.min, rate } : null
})
const recordingChannels = computed(() =>
  recording.value ? aisChannelsIn(recording.value.centerHz, recording.value.rate) : [],
)
const reachable = computed(() => {
  if (recording.value) return recordingChannels.value.length > 0
  return !centerSpec.value || reaches(centerSpec.value, AIS_CENTER_HZ)
})

/** The rate to ask for: 1.536 Msps where offered, else the lowest offered rate that holds both channels. */
const rateToUse = computed(() => {
  const s = rateSpec.value
  if (!s) return WANT_RATE
  if (!s.choices?.length) return Math.min(s.max, Math.max(s.min, WANT_RATE))
  if (s.choices.includes(WANT_RATE)) return WANT_RATE
  return s.choices.find((r) => r >= 240_000) ?? s.choices[s.choices.length - 1]
})

// ---------------------------------------------------------------------------
// receiver location
// ---------------------------------------------------------------------------

function loadHome(): { lat: string; lon: string } {
  try {
    const raw = localStorage.getItem(HOME_KEY)
    if (raw) {
      const v = JSON.parse(raw) as { lat?: unknown; lon?: unknown }
      if (typeof v.lat === 'string' && typeof v.lon === 'string') return { lat: v.lat, lon: v.lon }
    }
  } catch {
    // unreadable storage starts empty.
  }
  return { lat: '', lon: '' }
}

const saved = loadHome()
const homeLat = ref(saved.lat)
const homeLon = ref(saved.lon)
const homeError = ref<string | null>(null)

function saveHome(): void {
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: homeLat.value, lon: homeLon.value }))
  } catch {
    // private browsing. the location is typed again next time.
  }
}

const home = computed(() => {
  if (!homeLat.value.trim() || !homeLon.value.trim()) return null
  const lat = Number(homeLat.value)
  const lon = Number(homeLon.value)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
})
const homeBad = computed(() => !home.value && (homeLat.value.trim() !== '' || homeLon.value.trim() !== ''))

function useMyLocation(): void {
  homeError.value = null
  if (!navigator.geolocation) {
    homeError.value = 'this browser has no geolocation. type the position instead.'
    return
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      homeLat.value = pos.coords.latitude.toFixed(5)
      homeLon.value = pos.coords.longitude.toFixed(5)
      saveHome()
    },
    (err) => {
      homeError.value = `location refused: ${err.message.toLowerCase()}. type the position instead.`
    },
    { timeout: 15_000 },
  )
}

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

const receiver = new AisReceiver()
const fleet = new Fleet()
const vessels = shallowRef<Vessel[]>([])
const lines = ref<HbConsoleLine[]>([])
const messages = ref(0)
const perChannel = ref<Record<AisChannelId, number>>({ A: 0, B: 0 })
const lastOffsetHz = ref<number | null>(null)
const lastLevelDb = ref<number | null>(null)
let seq = 0

const live = ref(false)
const demo = ref(false)
const running = computed(() => live.value || demo.value)
const error = ref<string | null>(null)
const startedAt = ref(0)
const clock = ref(Date.now())
const tuned = ref<{ centerHz: number; rate: number } | null>(null)
let demoSource: AisDemoSource | null = null
let demoTimer = 0
let demoLast = 0

const tick = window.setInterval(() => {
  clock.value = Date.now()
  const before = vessels.value.length
  fleet.prune(clock.value, AGE_OUT_MS)
  const list = fleet.list()
  if (list.length !== before) vessels.value = list
}, 1000)

function onFrame(f: AisFrame): void {
  const at = Date.now()
  const msg = parseAis(f.bytes)
  const nmea = toNmea(f.bytes, f.channel, seq++)
  messages.value++
  perChannel.value = { ...perChannel.value, [f.channel]: perChannel.value[f.channel] + 1 }
  lastOffsetHz.value = f.offsetHz
  lastLevelDb.value = f.levelDb
  const t = formatClock(at)
  lines.value = [...lines.value, ...nmea.map((text) => ({ text, t }))].slice(-MAX_LINES)
  if (msg) {
    fleet.update(msg, f.channel, at)
    vessels.value = fleet.list()
  }
  emitArtifact(props.deviceId, {
    kind: 'packet',
    proto: 'ais',
    bytes: f.bytes,
    rssi: Math.round(f.levelDb),
    summary: msg ? `${msg.mmsi} ${describeAis(msg)}` : `ais type ${f.bytes[0] >> 2}`,
    fields: { ...(msg ?? {}), channel: f.channel, nmea, offsetHz: Math.round(f.offsetHz) },
  })
}
receiver.onFrame = onFrame

const stopBus = bus.onDeviceArtifact(props.deviceId, (a: Artifact) => {
  if (a.kind !== 'iq' || !live.value) return
  const c = a as IqChunk
  if (!tuned.value || tuned.value.centerHz !== c.centerHz || tuned.value.rate !== c.sampleRate) {
    tuned.value = { centerHz: c.centerHz, rate: c.sampleRate }
  }
  receiver.feed(c.samples, c.centerHz, c.sampleRate)
})

const heard = computed<AisChannelId[]>(() =>
  tuned.value ? aisChannelsIn(tuned.value.centerHz, tuned.value.rate) : [],
)

function startDemo(): void {
  const h = home.value ?? DEMO_HOME
  demoSource = new AisDemoSource(h.lat, h.lon)
  tuned.value = { centerHz: demoSource.centerHz, rate: demoSource.sampleRate }
  demo.value = true
  demoLast = performance.now()
  // blocks are sized from the clock, so a throttled background tab keeps time.
  demoTimer = window.setInterval(() => {
    const src = demoSource
    if (!src) return
    const now = performance.now()
    const ms = Math.min(2000, now - demoLast)
    demoLast = now
    if (ms > 0) receiver.feed(src.read(ms), src.centerHz, src.sampleRate)
  }, 50)
}

async function start(): Promise<void> {
  error.value = null
  receiver.reset()
  startedAt.value = Date.now()
  if (isSim.value) {
    startDemo()
    return
  }
  if (!reachable.value) return
  const t = lease.begin()
  try {
    const params: Record<string, number> = recording.value
      ? {}
      : { centerHz: AIS_CENTER_HZ, sampleRate: rateToUse.value }
    const g = gainSpec.value
    // ais is weak and bursty. the top of the range is auto gain where the tuner has it.
    if (g) params.gain = g.max
    if (Object.keys(params).length) await devices.configure(props.deviceId, params)
    if (!lease.current(t)) return
    live.value = true
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
  live.value = false
  await lease.release()
}

function clear(): void {
  fleet.clear()
  vessels.value = []
  lines.value = []
  messages.value = 0
  perChannel.value = { A: 0, B: 0 }
  lastOffsetHz.value = null
  lastLevelDb.value = null
}

onBeforeUnmount(() => {
  stopBus()
  window.clearInterval(tick)
  void stop()
})

// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

const quiet = computed(
  () => live.value && messages.value === 0 && clock.value - startedAt.value > QUIET_MS,
)
const offTune = computed(() => live.value && tuned.value !== null && heard.value.length === 0)

/** The point the plot is drawn around. */
const centre = computed(() => home.value ?? (demo.value ? DEMO_HOME : null))
const positioned = computed(() => vessels.value.filter((v) => v.lat !== undefined && v.lon !== undefined))

const rangeKm = computed(() => {
  const c = centre.value
  if (!c) return RANGES_KM[0]
  let far = 0
  for (const v of positioned.value) far = Math.max(far, distanceKm(c.lat, c.lon, v.lat!, v.lon!))
  return RANGES_KM.find((r) => r >= far * 1.1) ?? RANGES_KM[RANGES_KM.length - 1]
})

const blips = computed(() => {
  const c = centre.value
  if (!c) return []
  return positioned.value.map((v) => ({
    bearing: bearingDeg(c.lat, c.lon, v.lat!, v.lon!),
    distance: distanceKm(c.lat, c.lon, v.lat!, v.lon!) / rangeKm.value,
    label: (v.name || String(v.mmsi)).toLowerCase(),
  }))
})

function ago(ms: number): string {
  const s = Math.max(0, Math.round((clock.value - ms) / 1000))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  return `${Math.floor(s / 3600)} h`
}

function where(v: Vessel): string {
  if (v.lat === undefined || v.lon === undefined) return ''
  const pos = `${v.lat.toFixed(4)}, ${v.lon.toFixed(4)}`
  const c = centre.value
  if (!c) return pos
  const km = distanceKm(c.lat, c.lon, v.lat, v.lon)
  const brg = Math.round(bearingDeg(c.lat, c.lon, v.lat, v.lon))
  return `${pos}  ${km.toFixed(1)} km at ${String(brg).padStart(3, '0')}`
}

const columns: HbTableColumn[] = [
  { key: 'mmsi', label: 'mmsi', numeric: true },
  { key: 'name', label: 'name' },
  { key: 'callsign', label: 'call' },
  { key: 'type', label: 'type' },
  { key: 'position', label: 'position' },
  { key: 'sog', label: 'kn', numeric: true },
  { key: 'cog', label: 'cog', numeric: true },
  { key: 'hdg', label: 'hdg', numeric: true },
  { key: 'dest', label: 'destination' },
  { key: 'seen', label: 'seen', numeric: true },
]

const rows = computed(() =>
  vessels.value.map((v) => ({
    mmsi: String(v.mmsi),
    name: (v.name ?? '').toLowerCase(),
    callsign: (v.callsign ?? '').toLowerCase(),
    type: v.shipType ? shipTypeName(v.shipType) : v.kind,
    position: where(v),
    sog: v.sog === undefined ? '' : v.sog.toFixed(1),
    cog: v.cog === undefined ? '' : v.cog.toFixed(0),
    hdg: v.heading === undefined ? '' : String(v.heading),
    dest: (v.destination ?? '').toLowerCase(),
    seen: ago(v.lastSeen),
  })),
)

const source = computed(() => {
  if (demo.value || (isSim.value && !live.value)) return 'demo'
  if (!tuned.value) return 'idle'
  return formatHz(tuned.value.centerHz).toLowerCase()
})

const ids = { lat: `${uid}-lat`, lon: `${uid}-lon` }
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">messages</div>
        <div class="bn-v">{{ messages }}</div>
      </div>
      <div>
        <div class="bn-k">stations</div>
        <div class="bn-v">{{ vessels.length }}</div>
      </div>
      <div>
        <div class="bn-k">ch a / ch b</div>
        <div class="bn-v">{{ perChannel.A }} / {{ perChannel.B }}</div>
      </div>
      <div>
        <div class="bn-k">carrier off</div>
        <div class="bn-v">{{ lastOffsetHz === null ? '--' : `${Math.round(lastOffsetHz)} hz` }}</div>
      </div>
      <div>
        <div class="bn-k">source</div>
        <div class="bn-v">{{ source }}</div>
      </div>
    </div>

    <div class="bn-acts" style="margin-top: 10px">
      <HbButton v-if="!running" variant="danger" size="sm" :disabled="!isSim && !reachable" @click="start">
        <template #icon><HbIcon name="play" /></template>
        {{ isSim ? 'run demo harbour' : recording ? 'decode this recording' : 'listen on 161.975 and 162.025' }}
      </HbButton>
      <HbButton v-else size="sm" @click="stop">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="!messages" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
      <HbButton size="sm" @click="useMyLocation">
        <template #icon><HbIcon name="location-crosshairs" /></template>
        use my location
      </HbButton>
    </div>

    <p v-if="!isSim && !reachable && recording" class="bn-note" role="alert">
      this recording covers {{ ((recording.centerHz - recording.rate / 2) / 1e6).toFixed(3) }} to
      {{ ((recording.centerHz + recording.rate / 2) / 1e6).toFixed(3) }} mhz, which holds neither ais
      channel, 161.975 or 162.025.
    </p>
    <p v-else-if="!isSim && !reachable" class="bn-note" role="alert">
      the {{ tuner ? `${tuner.toLowerCase()} on this unit` : 'tuner on this unit' }} does not reach
      162.000 mhz, so it cannot hear ais.
    </p>
    <p v-if="error" class="bn-note" role="alert">{{ error }}</p>
    <p v-if="homeError" class="bn-note" role="alert">{{ homeError }}</p>
    <p v-if="live && recording" class="bn-note">
      decoding channel{{ recordingChannels.length > 1 ? 's' : '' }}
      {{ recordingChannels.map((c) => c.toLowerCase()).join(' and ') }} from the recording's
      {{ (recording.rate / 1e6).toFixed(3) }} msps window at {{ (recording.centerHz / 1e6).toFixed(3) }} mhz.
    </p>
    <p v-else-if="live" class="bn-note">
      listening to channels a and b from one {{ (rateToUse / 1e6).toFixed(3) }} msps window at 162.000 mhz.
    </p>
    <p v-if="offTune" class="bn-note" role="alert">
      the radio is streaming {{ tuned ? formatHz(tuned.centerHz).toLowerCase() : '' }}, which holds neither ais
      channel. another tool retuned it. press stop, then listen again.
    </p>
    <p v-if="quiet" class="bn-note" role="status">
      nothing decoded yet. ais needs line of sight to a coast or a large lake, so an inland bench
      hears nothing at all. if you are near water, check the ppm knob on the tune tab: a stick
      several khz off misses every burst.
    </p>

    <div class="bn-hint">
      <HbIcon name="water" :size="15" />
      <div>
        <b>no water, no ships</b>
        ais is line of sight on vhf. you need a coast, a port or a large lake within about 40 km,
        less behind hills. a bench far inland, like one in phoenix, will decode nothing, and that
        is the right answer. the demo harbour runs the same decoder on synthetic bursts.
      </div>
    </div>

    <div class="bn-knobs">
      <div class="bn-field">
        <label :for="ids.lat">receiver latitude</label>
        <input :id="ids.lat" v-model="homeLat" type="text" inputmode="decimal" placeholder="33.7400" @change="saveHome" />
      </div>
      <div class="bn-field">
        <label :for="ids.lon">receiver longitude</label>
        <input :id="ids.lon" v-model="homeLon" type="text" inputmode="decimal" placeholder="-118.2600" @change="saveHome" />
      </div>
    </div>
    <p v-if="homeBad" class="bn-note" role="alert">
      that position does not parse. use decimal degrees, negative for south and west.
    </p>

    <div class="bn-subhead" style="margin-top: 14px">
      around the receiver
      <span class="bn-aside">
        {{ centre ? `outer ring ${rangeKm} km` : 'set a receiver location to plot vessels' }}
      </span>
    </div>
    <InstRadar :blips="blips" :range-label="centre ? `${rangeKm} km` : ''" :size="300" />

    <div class="bn-subhead" style="margin-top: 14px">stations heard</div>
    <HbTable v-if="rows.length" :columns="columns" :rows="rows" />
    <p v-else class="bn-note">
      {{ running ? 'no stations yet. a ship sends its position every 2 to 10 seconds under way, every 3 minutes at anchor.' : 'press listen to start.' }}
    </p>

    <div class="bn-subhead" style="margin-top: 14px">
      !aivdm
      <span class="bn-aside">the raw sentences, as any chart plotter reads them</span>
    </div>
    <div class="bn-nmea"><HbConsole :lines="lines" height="200px" /></div>

    <div class="bn-hint">
      <HbIcon name="satellite-dish" :size="15" />
      <div>
        <b>what it does</b>
        tunes 162.000 mhz and splits the window into channel a at 161.975 and channel b at
        162.025. each burst is gmsk at 9600 baud. a coherent detector and an fm discriminator run
        side by side, and only frames whose crc checks are shown. types 1 to 5, 18, 19, 21 and 24
        are read into the table. every frame goes on the bus as an ais packet.
      </div>
    </div>
  </div>
</template>

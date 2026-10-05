<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { HbButton, HbIcon, HbInput, HbTable } from '@virgilvox/hackbuild-ui'
import InstRadar from '@/components/instruments/InstRadar.vue'
import { ADSB_HZ, ADSB_RATE, AGE_OUT_MS, bearingDeg, distanceKm, isDemodRate } from '@/core/decode/adsb'
import type { AdsbPacket, Aircraft, LatLon } from '@/core/decode/adsb'
import { AdsbDemoSource } from '@/core/decode/adsb/demo'
import type { FromWorker, ToWorker } from '@/core/decode/adsb/protocol'
import { bus } from '@/core/bus/DeviceBus'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { fixedWindow, reaches } from '@/core/dsp/spectrumMath'
import { formatHz, formatRate } from '@/core/format'
import { useDevices } from '@/stores/devices'
import type { Artifact, IqChunk } from '@/core/types'
import type { DeviceToolProps } from '@/tools/types'
import { useStreamLease } from '@/composables/useStreamLease'

const props = defineProps<DeviceToolProps>()
const devices = useDevices()
const lease = useStreamLease(props.deviceId)

const HOME_KEY = 'bench.sky.home'
/** Where the demo flies when you have not set a location. */
const DEMO_CENTRE: LatLon = { lat: 33.4484, lon: -112.074 }
const REFRESH_MS = 500
/** A quiet minute this long into a live run is worth saying out loud. */
const QUIET_MS = 20_000
const RANGES_KM = [30, 60, 120, 240, 480]
/** Past this much undecoded iq queued in the worker, blocks are dropped instead. */
const BACKLOG_S = 2
/** The bus gets at most one packet per aircraft this often, the latest heard. */
const EMIT_MS = 1000

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isSim = computed(() => (node.value ? isSimKind(node.value.kind) : false))
const tuner = computed(() => node.value?.info.tuner ?? '')
const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const rateSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'sampleRate'))
const gainSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'gain'))

/** A recording holds one window, so 1090 mhz is either its centre or out of reach. */
const recording = computed(() => {
  const s = centerSpec.value
  return s ? fixedWindow(s, node.value?.params.sampleRate ?? 0) : null
})
const recordingHz = computed(() => (recording.value ? (centerSpec.value?.min ?? 0) : 0))
const reachable = computed(() => !centerSpec.value || reaches(centerSpec.value, ADSB_HZ))
const topHz = computed(() => {
  const s = centerSpec.value
  if (!s) return 0
  return s.spans?.length ? s.spans[s.spans.length - 1][1] : s.max
})
/**
 * The decoder runs at 2.4 or 2 Msps. A radio gets 2.4, and a recording made
 * at 2, as dump1090's own test files are, plays at the rate it was taken.
 */
const tuneRate = computed(() => {
  const s = rateSpec.value
  if (!s) return ADSB_RATE
  const offers = (r: number) => (s.choices?.length ? s.choices.includes(r) : r >= s.min && r <= s.max)
  if (offers(ADSB_RATE)) return ADSB_RATE
  return offers(2_000_000) ? 2_000_000 : 0
})
const rateOk = computed(() => tuneRate.value > 0)

const worker = new Worker(new URL('../../core/decode/adsb/adsb.worker.ts', import.meta.url), {
  type: 'module',
})
function post(msg: ToWorker, transfer: Transferable[] = []): void {
  worker.postMessage(msg, transfer)
}

const live = ref(false)
const demo = ref(false)
const running = computed(() => live.value || demo.value)
const error = ref<string | null>(null)
let startedAt = 0
const gotSamples = ref(false)
const offTuneHz = ref(0)
const badRate = ref(0)

const aircraft = shallowRef<Aircraft[]>([])
const messages = ref(0)
const repaired = ref(0)
const preambles = ref(0)
const rate = ref(0)
const clock = ref(Date.now())
const quiet = ref(false)

// ---------------------------------------------------------------------------
// receiver location
// ---------------------------------------------------------------------------

function loadHome(): { lat: string; lon: string } {
  try {
    const raw = localStorage.getItem(HOME_KEY)
    if (raw) {
      const v = JSON.parse(raw) as { lat?: unknown; lon?: unknown }
      return { lat: String(v.lat ?? ''), lon: String(v.lon ?? '') }
    }
  } catch {
    // storage blocked or the value is damaged, start empty.
  }
  return { lat: '', lon: '' }
}

const saved = loadHome()
const homeLat = ref(saved.lat)
const homeLon = ref(saved.lon)
const homeError = ref<string | null>(null)
const locating = ref(false)

const home = computed<LatLon | null>(() => {
  if (!homeLat.value.trim() || !homeLon.value.trim()) return null
  const lat = Number(homeLat.value)
  const lon = Number(homeLon.value)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
})

watch([homeLat, homeLon], () => {
  try {
    localStorage.setItem(HOME_KEY, JSON.stringify({ lat: homeLat.value, lon: homeLon.value }))
  } catch {
    // the location still works for this session.
  }
})

watch(home, (h) => post({ type: 'receiver', at: h ? { ...h } : null }), { immediate: true })

function useMyLocation(): void {
  homeError.value = null
  if (!navigator.geolocation) {
    homeError.value = 'this browser has no geolocation, type your position instead'
    return
  }
  locating.value = true
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      locating.value = false
      homeLat.value = pos.coords.latitude.toFixed(4)
      homeLon.value = pos.coords.longitude.toFixed(4)
    },
    (err) => {
      locating.value = false
      homeError.value = `location refused: ${err.message}. type your position instead`
    },
    { maximumAge: 600_000, timeout: 15_000 },
  )
}

/** The radar's centre: you, or the demo's made up airspace. */
const centre = computed<LatLon | null>(() => home.value ?? (demo.value ? DEMO_CENTRE : null))

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

/** The latest packet per aircraft since its last emit, and how many frames that covers. */
const pending = new Map<string, { p: AdsbPacket; n: number }>()
const lastEmit = new Map<string, number>()

function hold(p: AdsbPacket): void {
  const key = String(p.fields.icao ?? '')
  const prev = pending.get(key)
  pending.set(key, { p, n: (prev?.n ?? 0) + 1 })
}

function publishDue(now: number): void {
  for (const [key, { p, n }] of pending) {
    if (now - (lastEmit.get(key) ?? -Infinity) < EMIT_MS) continue
    pending.delete(key)
    lastEmit.set(key, now)
    bus.emitDecoded(props.deviceId, {
      kind: 'packet',
      bytes: p.bytes,
      proto: 'adsb',
      rssi: p.rssi,
      fields: { ...p.fields, messages: n },
      summary: p.summary,
    })
  }
  for (const [key, at] of lastEmit) if (now - at > AGE_OUT_MS) lastEmit.delete(key)
}

function dropPending(): void {
  pending.clear()
  lastEmit.clear()
}

let postedSamples = 0
let consumedSamples = 0
let droppedHere = 0

/** Hands a block to the worker, or drops it when the worker is behind. */
function feed(iq: Float32Array, rate: number, dropped: number): void {
  const n = iq.length >> 1
  if (postedSamples - consumedSamples > rate * BACKLOG_S) {
    droppedHere += n + dropped
    return
  }
  postedSamples += n
  post({ type: 'feed', iq, rate, dropped: dropped + droppedHere }, [iq.buffer])
  droppedHere = 0
}

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const msg = e.data
  if (msg.type === 'packets') {
    // demo traffic stays in the panel, so the session log and automations see only real air.
    if (live.value) for (const p of msg.packets) hold(p)
    return
  }
  consumedSamples = msg.consumed
  // a lone frame repaired from an address never heard before is as likely
  // noise as an aircraft, so an address shows once it has been heard twice.
  aircraft.value = msg.aircraft.filter((a) => a.messages >= 2)
  messages.value = msg.messages
  repaired.value = msg.repaired
  preambles.value = msg.preambles
  clock.value = msg.now
}

const stopBus = bus.onDeviceArtifact(props.deviceId, (a: Artifact) => {
  if (a.kind !== 'iq' || !live.value) return
  const chunk = a as IqChunk
  gotSamples.value = true
  if (chunk.centerHz !== ADSB_HZ) {
    offTuneHz.value = chunk.centerHz
    return
  }
  offTuneHz.value = 0
  if (!isDemodRate(chunk.sampleRate)) {
    badRate.value = chunk.sampleRate
    return
  }
  badRate.value = 0
  // the bus hands the same block to every subscriber, so the worker gets a copy.
  feed(chunk.samples.slice(), chunk.sampleRate, chunk.dropped)
})

let source: AdsbDemoSource | null = null
let demoTimer = 0
let demoLast = 0

function stopDemo(): void {
  if (demoTimer) clearInterval(demoTimer)
  demoTimer = 0
  source = null
  demo.value = false
}

function startDemo(): void {
  stopDemo()
  source = new AdsbDemoSource(home.value ?? DEMO_CENTRE)
  demo.value = true
  demoLast = performance.now()
  // blocks are sized from the clock, so a throttled background tab still
  // plays the traffic at its real pace.
  demoTimer = window.setInterval(() => {
    const src = source
    if (!src) return
    const now = performance.now()
    const ms = Math.min(500, now - demoLast)
    demoLast = now
    if (ms <= 0) return
    feed(src.read(ms), src.sampleRate, 0)
  }, 50)
}

async function start(): Promise<void> {
  error.value = null
  startedAt = performance.now()
  quiet.value = false
  if (isSim.value) {
    startDemo()
    return
  }
  const n = node.value
  if (!n) return
  const t = lease.begin()
  const params: Record<string, number> = { centerHz: ADSB_HZ, sampleRate: tuneRate.value }
  const g = gainSpec.value
  // the top of the rtl-sdr gain range hands over to the tuner's agc, which
  // chases the noise between replies, so the panel takes the top manual step.
  if (g) params.gain = g.topLabel ? g.max - 1 : g.max
  try {
    await devices.configure(props.deviceId, params)
  } catch (err) {
    if (!lease.current(t)) return
    error.value = err instanceof Error ? err.message : String(err)
    void lease.release()
    return
  }
  if (!lease.current(t)) return
  const after = node.value
  if (!after || after.params.centerHz !== ADSB_HZ) {
    error.value = `the radio did not take 1090 mhz${after?.error ? `: ${after.error}` : ''}`
    void lease.release()
    return
  }
  try {
    if (!(await lease.stream(t))) return
    gotSamples.value = false
    live.value = true
  } catch (err) {
    if (!lease.current(t)) return
    error.value = err instanceof Error ? err.message : String(err)
    void lease.release()
  }
}

async function stop(): Promise<void> {
  stopDemo()
  live.value = false
  dropPending()
  await lease.release()
}

function clear(): void {
  post({ type: 'reset' })
  dropPending()
  aircraft.value = []
  messages.value = 0
  repaired.value = 0
  lastCount = 0
}

let lastCount = 0
let lastTick = performance.now()
const refresh = window.setInterval(() => {
  post({ type: 'snapshot' })
  const now = performance.now()
  publishDue(now)
  const dt = (now - lastTick) / 1000
  if (dt >= 1) {
    rate.value = Math.max(0, (messages.value - lastCount) / dt)
    lastCount = messages.value
    lastTick = now
  }
  quiet.value = live.value && messages.value === 0 && now - startedAt > QUIET_MS
}, REFRESH_MS)

onBeforeUnmount(() => {
  clearInterval(refresh)
  stopBus()
  void stop()
  worker.terminate()
})

// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

interface Placed {
  a: Aircraft
  km: number | null
  brg: number | null
}

const placed = computed<Placed[]>(() => {
  const c = centre.value
  return aircraft.value
    .map((a) => {
      if (!c || !a.position) return { a, km: null, brg: null }
      return { a, km: distanceKm(c, a.position), brg: bearingDeg(c, a.position) }
    })
    .sort((x, y) => (x.km ?? Infinity) - (y.km ?? Infinity) || x.a.hex.localeCompare(y.a.hex))
})

const withPosition = computed(() => aircraft.value.filter((a) => a.position))
const onRadar = computed(() => placed.value.filter((p) => p.km !== null))

const rangeKm = computed(() => {
  const far = Math.max(0, ...onRadar.value.map((p) => p.km ?? 0))
  return RANGES_KM.find((r) => r >= far * 1.1) ?? RANGES_KM[RANGES_KM.length - 1]
})

const blips = computed(() =>
  onRadar.value
    .filter((p) => (p.km ?? 0) <= rangeKm.value)
    .map((p) => ({
      bearing: p.brg ?? 0,
      distance: (p.km ?? 0) / rangeKm.value,
      label: p.a.callsign || p.a.hex,
    })),
)

const rangeLabel = computed(() => `rings ${rangeKm.value / 3} km apart`)

function ago(at: number): string {
  const s = Math.max(0, Math.round((clock.value - at) / 1000))
  return `${s} s`
}

const columns = [
  { key: 'callsign', label: 'callsign' },
  { key: 'icao', label: 'icao' },
  { key: 'alt', label: 'alt ft', numeric: true },
  { key: 'speed', label: 'kt', numeric: true },
  { key: 'heading', label: 'hdg', numeric: true },
  { key: 'dist', label: 'km', numeric: true },
  { key: 'msgs', label: 'msgs', numeric: true },
  { key: 'seen', label: 'seen', numeric: true },
]

const rows = computed(() =>
  placed.value.map(({ a, km }) => {
    const hdg = a.trackDeg ?? a.headingDeg
    return {
      callsign: a.callsign ?? '',
      icao: a.hex,
      alt: a.onGround ? 'ground' : a.altitudeFt !== undefined ? String(a.altitudeFt) : '',
      speed: a.groundSpeedKt !== undefined ? String(Math.round(a.groundSpeedKt)) : a.airspeedKt !== undefined ? String(a.airspeedKt) : '',
      heading: hdg !== undefined ? String(Math.round(hdg)).padStart(3, '0') : '',
      dist: km !== null ? km.toFixed(1) : '',
      msgs: String(a.messages),
      seen: ago(a.lastSeen),
    }
  }),
)

const source_ = computed(() => {
  if (demo.value) return 'demo'
  if (live.value) return '1090 mhz'
  return 'idle'
})

const status = computed<string | null>(() => {
  if (!live.value) return null
  if (offTuneHz.value) {
    return `another tool moved the radio to ${formatHz(offTuneHz.value).toLowerCase()}. press stop and start to come back to 1090 mhz`
  }
  if (badRate.value) return `the radio is running ${badRate.value} sps. the decoder takes 2.4 or 2 msps`
  if (!gotSamples.value) return 'waiting for samples from the radio'
  if (quiet.value) {
    return preambles.value
      ? 'preambles but no frame passed the parity check yet. the signal is too weak or the front end is overloaded'
      : 'nothing decoded yet. 1090 mhz wants a clear view of the sky, so try the antenna at a window or outdoors'
  }
  return null
})
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">aircraft</div>
        <div class="bn-v">{{ aircraft.length }}</div>
      </div>
      <div>
        <div class="bn-k">with position</div>
        <div class="bn-v">{{ withPosition.length }}</div>
      </div>
      <div>
        <div class="bn-k">messages</div>
        <div class="bn-v">{{ messages }}</div>
      </div>
      <div>
        <div class="bn-k">msg/s</div>
        <div class="bn-v">{{ rate.toFixed(1) }}</div>
      </div>
      <div>
        <div class="bn-k">repaired</div>
        <div class="bn-v is-goo">{{ repaired }}</div>
      </div>
      <div>
        <div class="bn-k">listening</div>
        <div class="bn-v">{{ source_ }}</div>
      </div>
    </div>

    <p v-if="!reachable && recording" class="bn-note" role="alert">
      this recording sits at {{ formatHz(recordingHz, 3).toLowerCase() }}. the sky tab needs one
      centred on 1090 mhz.
    </p>
    <p v-else-if="!reachable" class="bn-note" role="alert">
      this {{ tuner ? `${tuner.toLowerCase()} stick` : 'radio' }} cannot reach 1090 mhz. it tops
      out at {{ formatHz(topHz, 1).toLowerCase() }}. an r820t or r828d stick, such as a nooelec
      nesdr or an rtl-sdr blog v3 or v4, covers 1090 mhz.
    </p>
    <p v-else-if="!rateOk" class="bn-note" role="alert">
      {{
        recording
          ? `this recording was taken at ${formatRate(node?.params.sampleRate ?? 0).toLowerCase()}. the decoder takes 2.4 or 2 msps.`
          : 'this radio cannot run at 2.4 or 2 msps, the two rates the decoder takes.'
      }}
    </p>

    <div class="bn-acts">
      <HbButton
        v-if="!running"
        variant="danger"
        size="sm"
        :disabled="!reachable || !rateOk"
        @click="start"
      >
        <template #icon><HbIcon name="play" /></template>
        {{ isSim ? 'run demo traffic' : 'listen on 1090 mhz' }}
      </HbButton>
      <HbButton v-else size="sm" @click="stop">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="!aircraft.length && !messages" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
      <HbButton size="sm" :disabled="locating" @click="useMyLocation">
        <template #icon><HbIcon name="location-crosshairs" /></template>
        {{ locating ? 'locating' : 'use my location' }}
      </HbButton>
    </div>

    <p v-if="error" class="bn-note" role="alert">{{ error }}</p>
    <div aria-live="polite">
      <p v-if="status" class="bn-note">{{ status }}</p>
    </div>
    <p v-if="homeError" class="bn-note">{{ homeError }}</p>

    <div class="bn-knobs">
      <div class="bn-field">
        <label for="sky-home-lat">your latitude</label>
        <HbInput id="sky-home-lat" v-model="homeLat" type="text" inputmode="decimal" autocomplete="off" placeholder="33.4484" />
      </div>
      <div class="bn-field">
        <label for="sky-home-lon">your longitude</label>
        <HbInput id="sky-home-lon" v-model="homeLon" type="text" inputmode="decimal" autocomplete="off" placeholder="-112.0740" />
      </div>
    </div>

    <p v-if="(homeLat || homeLon) && !home" class="bn-note">
      that position does not parse. use decimal degrees, negative for south and west.
    </p>
    <p v-else-if="!home && !demo" class="bn-note">
      set your location to place aircraft on the radar. positions decode without it, from
      pairs of reports, and the table still fills.
    </p>
    <p v-else-if="!home && demo" class="bn-note">
      the demo flies around a made up centre. set your location to fly it around you.
    </p>

    <div class="bn-sky">
      <InstRadar
        v-if="centre"
        :blips="blips"
        :range-label="rangeLabel"
        :size="360"
      />
      <HbTable :columns="columns" :rows="rows" />
    </div>
    <p v-if="!aircraft.length" class="bn-note">
      {{ running ? 'no aircraft yet.' : 'press start to listen.' }}
      aircraft drop off the list after {{ AGE_OUT_MS / 1000 }} s of silence.
    </p>

    <div class="bn-hint">
      <HbIcon name="plane" :size="15" />
      <div>
        <b>what this hears</b>
        aircraft answer radar and broadcast their own position on 1090 mhz. the panel tunes the
        radio there at 2.4 msps with gain at its top manual step, checks every reply's parity,
        and repairs one flipped bit on extended squitters and all-call replies. reception is line
        of sight, so a quarter wave whip, 69 mm, high up or at a window matters more than gain.
      </div>
    </div>

    <div v-if="isSim" class="bn-hint">
      <HbIcon name="flask" :size="15" />
      <div>
        <b>demo</b>
        this device is simulated, so the panel renders six made up aircraft as real mode s
        frames in 2.4 msps iq with noise, and runs them through the same decoder in real time.
      </div>
    </div>
  </div>
</template>

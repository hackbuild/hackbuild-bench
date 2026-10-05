<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstRadar from '@/components/instruments/InstRadar.vue'
import InstPacketList from '@/components/instruments/InstPacketList.vue'
import { bus } from '@/core/bus/DeviceBus'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { fixedWindow, reaches } from '@/core/dsp/spectrumMath'
import { bearingDeg, distanceKm } from '@/core/decode/aprs'
import { SondeReceiver } from '@/core/decode/radiosonde/receiver'
import type { SondeFrameMeta } from '@/core/decode/radiosonde/receiver'
import { SCAN_RATE, SONDE_HIGH_HZ, SONDE_LOW_HZ, SondeScanner, keptSpan, scanPlan } from '@/core/decode/radiosonde/scan'
import type { SondeCandidate } from '@/core/decode/radiosonde/scan'
import { SondeDemoSource } from '@/core/decode/radiosonde/demo'
import type { Rs41Frame } from '@/core/decode/radiosonde/rs41'
import { formatClock } from '@/core/format'
import { useDevices } from '@/stores/devices'
import { useStreamLease } from '@/composables/useStreamLease'
import type { Artifact, IqChunk } from '@/core/types'
import { emitArtifact } from '@/tools/emit'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()
const devices = useDevices()
const lease = useStreamLease(props.deviceId)
const uid = useId()

const HOME_KEY = 'bench.sonde.home'
const DEMO_HOME = { lat: 33.4484, lon: -112.074 }
/** Rate for following one sonde: a quarter megasample keeps the usb link and the filter light. */
const TRACK_RATE = 250_000
/** The sonde sits this far from the window centre, clear of a zero if tuner's dc spike. */
const TRACK_OFFSET_HZ = 60_000
/** Long enough to catch the half of each second an RS41 is keyed. */
const DWELL_S = 1.4
/** Chunks dropped after a retune while the pll settles. */
const SETTLE_CHUNKS = 3
/** A lock with no frame for this long goes back to scanning. */
const LOST_MS = 30_000
const MAX_TRACK = 3600
const MAX_FRAMES = 200

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isSim = computed(() => (node.value ? isSimKind(node.value.kind) : false))
const tuner = computed(() => node.value?.info.tuner ?? '')
const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const rateSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'sampleRate'))
const gainSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'gain'))
/**
 * A recording cannot retune, so it is scanned only across the part of its
 * window the scanner trusts, and a sonde inside that is followed where it
 * sits.
 */
const recordingWindow = computed(() => {
  const s = centerSpec.value
  const rate = node.value?.params.sampleRate ?? 0
  return s && fixedWindow(s, rate) ? keptSpan(s.min, rate) : null
})

const reachable = computed(() => {
  const w = recordingWindow.value
  if (w) return w[1] > SONDE_LOW_HZ && w[0] < SONDE_HIGH_HZ
  return !centerSpec.value || (reaches(centerSpec.value, SONDE_LOW_HZ) && reaches(centerSpec.value, SONDE_HIGH_HZ))
})

/**
 * The highest offered rate at or under the one wanted. A faster rate costs
 * main thread time and gives fft bins coarser than the scan grid, which
 * leaves grid steps unmarked.
 */
function nearestRate(want: number): number {
  const s = rateSpec.value
  if (!s?.choices?.length) return s ? Math.min(s.max, Math.max(s.min, want)) : want
  const under = s.choices.filter((r) => r <= want)
  if (under.length) return Math.max(...under)
  return Math.min(...s.choices)
}

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
// scan, lock, decode
// ---------------------------------------------------------------------------

type Stage = 'idle' | 'scan' | 'track'
const stage = ref<Stage>('idle')
const live = ref(false)
const demo = ref(false)
const running = computed(() => live.value || demo.value)
const error = ref<string | null>(null)
const scanRate = ref(SCAN_RATE)
const plan = shallowRef<number[]>(scanPlan())
const step = ref(0)
const candidates = shallowRef<SondeCandidate[]>([])
const scansEmpty = ref(0)
const lockedHz = ref(0)
const trackedHz = ref(0)
const lastFrameAt = ref(0)
const lockedAt = ref(0)
const clock = ref(Date.now())

const scanner = new SondeScanner()
const receiver = new SondeReceiver()
let want = { centerHz: 0, rate: 0 }
let settle = 0
let dwell = 0
let demoSource: SondeDemoSource | null = null
let demoTimer = 0
let demoLast = 0

interface TrackPoint {
  lat: number
  lon: number
  alt: number
  at: number
}

const latest = shallowRef<Rs41Frame | null>(null)
const track = shallowRef<TrackPoint[]>([])
const frames = ref<Array<{ id: string; a: string; b: string; c: string; decode: string }>>([])
const frameCount = ref(0)

const tick = window.setInterval(() => {
  clock.value = Date.now()
  if (stage.value === 'track' && running.value) {
    const quietSince = Math.max(lastFrameAt.value, lockedAt.value)
    if (clock.value - quietSince > LOST_MS) void beginScan()
  }
}, 1000)

/** Asks the radio for a window. In demo the source renders whatever is asked. */
async function retune(centerHz: number, rate: number): Promise<void> {
  const fixed = recordingWindow.value
  const n = node.value
  if (fixed && n && !demo.value) {
    want = { centerHz: n.params.centerHz, rate: n.params.sampleRate }
    settle = 0
    dwell = 0
    return
  }
  want = { centerHz, rate }
  settle = demo.value ? 0 : SETTLE_CHUNKS
  dwell = 0
  if (demo.value) return
  try {
    await devices.configure(props.deviceId, { centerHz, sampleRate: rate })
  } catch (err) {
    error.value = err instanceof Error ? err.message.toLowerCase() : String(err)
  }
}

async function beginScan(): Promise<void> {
  stage.value = 'scan'
  scanner.reset()
  const fixed = !!recordingWindow.value && !demo.value
  scanner.dcGuard = !fixed
  scanRate.value = fixed ? (node.value?.params.sampleRate ?? SCAN_RATE) : demo.value ? SCAN_RATE : nearestRate(SCAN_RATE)
  plan.value = scanPlan(scanRate.value)
  step.value = 0
  await retune(plan.value[0], scanRate.value)
}

/** Two candidates closer than this are the same sonde drifting. */
const SAME_SONDE_HZ = 20_000

async function lock(hz: number): Promise<void> {
  if (!running.value) return
  if (lockedHz.value && Math.abs(hz - lockedHz.value) > SAME_SONDE_HZ) track.value = []
  stage.value = 'track'
  lockedHz.value = hz
  lockedAt.value = Date.now()
  receiver.tune(hz)
  await retune(Math.round(hz + TRACK_OFFSET_HZ), nearestRate(TRACK_RATE))
}

async function scanned(): Promise<void> {
  const c = scanner.candidates()
  candidates.value = c
  if (!c.length) {
    scansEmpty.value++
    await beginScan()
    return
  }
  scansEmpty.value = 0
  await lock(c[0].hz)
}

/** A tuner rounds what it is asked for, so a chunk counts when it lands close. */
function isWanted(centerHz: number, rate: number): boolean {
  return Math.abs(centerHz - want.centerHz) < 5_000 && Math.abs(rate - want.rate) < want.rate * 0.01
}

function process(iq: Float32Array, centerHz: number, rate: number): void {
  if (!isWanted(centerHz, rate)) return
  if (settle > 0) {
    settle--
    return
  }
  if (stage.value === 'scan') {
    scanner.feed(iq, centerHz, rate)
    dwell += iq.length / 2
    if (dwell < DWELL_S * rate) return
    if (step.value + 1 < plan.value.length && !(recordingWindow.value && !demo.value)) {
      step.value++
      void retune(plan.value[step.value], rate)
    } else {
      void scanned()
    }
    return
  }
  if (stage.value === 'track') receiver.feed(iq, centerHz, rate)
}

receiver.onFrame = (f: Rs41Frame, meta: SondeFrameMeta) => {
  // a frame whose status block failed has no serial to file it under.
  if (!f.serial || f.frame < 0) return
  const at = Date.now()
  lastFrameAt.value = at
  trackedHz.value = meta.frequencyHz
  frameCount.value++
  // a different serial is a different sonde, whose points must not join the last one's.
  if (latest.value && latest.value.serial !== f.serial) track.value = []
  if (f.lat !== undefined && f.lon !== undefined && f.alt !== undefined) {
    track.value = [...track.value, { lat: f.lat, lon: f.lon, alt: f.alt, at }].slice(-MAX_TRACK)
  }
  latest.value = f
  const pos = f.lat !== undefined ? `${f.lat.toFixed(5)}, ${f.lon!.toFixed(5)}, ${Math.round(f.alt!)} m` : 'no gps fix in this frame'
  frames.value = [
    {
      id: `${f.serial}-${f.frame}-${at}`,
      a: f.serial.toLowerCase(),
      b: `frame ${f.frame}  ${formatClock(at)}`,
      c: f.climb !== undefined ? `${f.climb >= 0 ? '+' : ''}${f.climb.toFixed(1)} m/s` : '',
      decode: pos + (f.corrected[0] + f.corrected[1] > 0 ? `  ${f.corrected[0] + f.corrected[1]} bytes corrected` : ''),
    },
    ...frames.value,
  ].slice(0, MAX_FRAMES)
  emitArtifact(props.deviceId, {
    kind: 'packet',
    proto: 'radiosonde',
    bytes: f.bytes,
    rssi: Math.round(meta.levelDb),
    summary: `rs41 ${f.serial.toLowerCase()} frame ${f.frame}${f.alt !== undefined ? ` ${Math.round(f.alt)} m` : ''}`,
    fields: {
      type: 'rs41',
      serial: f.serial,
      frame: f.frame,
      time: f.time,
      lat: f.lat,
      lon: f.lon,
      alt: f.alt,
      speed: f.speed,
      heading: f.heading,
      climb: f.climb,
      sats: f.sats,
      battery: f.battery,
      temperature: f.temperature,
      humidityCalibrated: false,
      frequencyHz: Math.round(meta.frequencyHz),
      corrected: f.corrected,
    },
  })
}

const stopBus = bus.onDeviceArtifact(props.deviceId, (a: Artifact) => {
  if (a.kind !== 'iq' || !live.value) return
  const c = a as IqChunk
  process(c.samples, c.centerHz, c.sampleRate)
})

async function start(): Promise<void> {
  error.value = null
  scansEmpty.value = 0
  if (isSim.value) {
    const h = home.value ?? DEMO_HOME
    demoSource = new SondeDemoSource(h.lat, h.lon)
    demo.value = true
    await beginScan()
    demoLast = performance.now()
    // blocks are sized from the clock, so a throttled background tab keeps time.
    demoTimer = window.setInterval(() => {
      const src = demoSource
      if (!src || !want.rate) return
      const now = performance.now()
      const ms = Math.min(500, now - demoLast)
      demoLast = now
      if (ms > 0) process(src.read(ms, want.centerHz, want.rate), want.centerHz, want.rate)
    }, 50)
    return
  }
  if (!reachable.value) return
  const t = lease.begin()
  try {
    const g = gainSpec.value
    // the top of the range is auto gain where the tuner has it.
    if (g) await devices.configure(props.deviceId, { gain: g.max })
    if (!lease.current(t)) return
    live.value = true
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
  stage.value = 'idle'
  want = { centerHz: 0, rate: 0 }
  candidates.value = []
  live.value = false
  await lease.release()
}

function clear(): void {
  latest.value = null
  track.value = []
  frames.value = []
  frameCount.value = 0
}

onBeforeUnmount(() => {
  stopBus()
  window.clearInterval(tick)
  void stop()
})

// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

const centre = computed(() => home.value ?? (demo.value ? DEMO_HOME : null))

const fix = computed(() => {
  const f = latest.value
  const c = centre.value
  if (!f || f.lat === undefined || f.lon === undefined || !c) return null
  const km = distanceKm(c.lat, c.lon, f.lat, f.lon)
  const alt = f.alt ?? 0
  return {
    km,
    bearing: bearingDeg(c.lat, c.lon, f.lat, f.lon),
    // flat earth is close enough at the ranges a sonde is heard.
    elevation: (Math.atan2(alt, km * 1000) * 180) / Math.PI,
  }
})

const rangeKm = computed(() => {
  const c = centre.value
  let far = 10
  if (c) for (const p of track.value) far = Math.max(far, distanceKm(c.lat, c.lon, p.lat, p.lon))
  return [10, 25, 50, 100, 200, 400, 800].find((r) => r >= far * 1.1) ?? 800
})

const blips = computed(() => {
  const c = centre.value
  if (!c || !track.value.length) return []
  const pts = track.value
  const stride = Math.max(1, Math.floor(pts.length / 40))
  const out = []
  for (let i = 0; i < pts.length; i += stride) {
    const p = pts[i]
    out.push({
      bearing: bearingDeg(c.lat, c.lon, p.lat, p.lon),
      distance: distanceKm(c.lat, c.lon, p.lat, p.lon) / rangeKm.value,
      label: '',
    })
  }
  const last = pts[pts.length - 1]
  out.push({
    bearing: bearingDeg(c.lat, c.lon, last.lat, last.lon),
    distance: distanceKm(c.lat, c.lon, last.lat, last.lon) / rangeKm.value,
    label: `${(latest.value?.serial ?? '').toLowerCase()} ${Math.round(last.alt)} m`,
  })
  return out
})

const status = computed(() => {
  if (!running.value) return ''
  if (stage.value === 'scan') {
    const w = recordingWindow.value
    if (w && !demo.value) return `scanning the recording, ${(w[0] / 1e6).toFixed(3)} to ${(w[1] / 1e6).toFixed(3)} mhz`
    const [lo, hi] = keptSpan(plan.value[step.value], scanRate.value)
    return `scanning ${(lo / 1e6).toFixed(1)} to ${(hi / 1e6).toFixed(1)} mhz, window ${step.value + 1} of ${plan.value.length}`
  }
  const f = (trackedHz.value || lockedHz.value) / 1e6
  const quiet = Math.max(0, Math.round((clock.value - Math.max(lastFrameAt.value, lockedAt.value)) / 1000))
  return lastFrameAt.value > lockedAt.value
    ? `locked to ${f.toFixed(4)} mhz, last frame ${quiet} s ago`
    : `listening at ${f.toFixed(4)} mhz for a frame, ${quiet} s so far`
})

function fmt(v: number | undefined, digits: number, unit: string): string {
  return v === undefined ? '--' : `${v.toFixed(digits)} ${unit}`
}

const temperature = computed(() => {
  const f = latest.value
  if (!f) return '--'
  if (f.temperature !== undefined) return `${f.temperature.toFixed(1)} c`
  return `uncalibrated, ${f.calibration} of 51`
})

const ids = { lat: `${uid}-lat`, lon: `${uid}-lon` }
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">sonde</div>
        <div class="bn-v">{{ latest ? latest.serial.toLowerCase() : '--' }}</div>
      </div>
      <div>
        <div class="bn-k">frame</div>
        <div class="bn-v">{{ latest ? latest.frame : '--' }}</div>
      </div>
      <div>
        <div class="bn-k">altitude</div>
        <div class="bn-v">{{ fmt(latest?.alt, 0, 'm') }}</div>
      </div>
      <div>
        <div class="bn-k">climb</div>
        <div class="bn-v">{{ fmt(latest?.climb, 1, 'm/s') }}</div>
      </div>
      <div>
        <div class="bn-k">distance</div>
        <div class="bn-v">{{ fix ? `${fix.km.toFixed(1)} km` : '--' }}</div>
      </div>
      <div>
        <div class="bn-k">bearing</div>
        <div class="bn-v">{{ fix ? `${String(Math.round(fix.bearing)).padStart(3, '0')}` : '--' }}</div>
      </div>
    </div>

    <div class="bn-acts" style="margin-top: 10px">
      <HbButton v-if="!running" variant="danger" size="sm" :disabled="!isSim && !reachable" @click="start">
        <template #icon><HbIcon name="play" /></template>
        {{ isSim ? 'run demo flight' : recordingWindow ? 'scan this recording' : 'scan 400 to 406 mhz' }}
      </HbButton>
      <HbButton v-else size="sm" @click="stop">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="!running || stage === 'scan'" @click="beginScan">
        <template #icon><HbIcon name="repeat" /></template>
        rescan
      </HbButton>
      <HbButton size="sm" :disabled="!frameCount" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
      <HbButton size="sm" @click="useMyLocation">
        <template #icon><HbIcon name="location-crosshairs" /></template>
        use my location
      </HbButton>
    </div>

    <p v-if="!isSim && !reachable && recordingWindow" class="bn-note" role="alert">
      this recording holds {{ (recordingWindow[0] / 1e6).toFixed(3) }} to
      {{ (recordingWindow[1] / 1e6).toFixed(3) }} mhz, outside 400 to 406 mhz where radiosondes are.
    </p>
    <p v-else-if="!isSim && !reachable" class="bn-note" role="alert">
      the {{ tuner ? `${tuner.toLowerCase()} on this unit` : 'tuner on this unit' }} does not reach
      400 to 406 mhz, so it cannot hear radiosondes.
    </p>
    <p v-if="error" class="bn-note" role="alert">{{ error }}</p>
    <p v-if="homeError" class="bn-note" role="alert">{{ homeError }}</p>
    <p v-if="status" class="bn-note" role="status">{{ status }}</p>
    <p v-if="running && scansEmpty > 0 && stage === 'scan'" class="bn-note" role="status">
      nothing over the noise floor on {{ scansEmpty }} {{ scansEmpty === 1 ? 'pass' : 'passes' }}. scanning
      again. sondes go up at 00 and 12 utc and are heard for about two hours after.
    </p>

    <div v-if="candidates.length > 1" class="bn-subhead" style="margin-top: 12px">
      heard in the band
      <span class="bn-aside">the strongest is followed. pick another to follow it.</span>
    </div>
    <div v-if="candidates.length > 1" class="bn-acts">
      <HbButton
        v-for="c in candidates"
        :key="c.hz"
        size="sm"
        :disabled="!running"
        :aria-pressed="Math.abs(c.hz - lockedHz) < 1"
        @click="lock(c.hz)"
      >
        {{ (c.hz / 1e6).toFixed(3) }} mhz, {{ c.snrDb.toFixed(0) }} db
      </HbButton>
    </div>

    <div class="bn-knobs">
      <div class="bn-field">
        <label :for="ids.lat">receiver latitude</label>
        <input :id="ids.lat" v-model="homeLat" type="text" inputmode="decimal" placeholder="33.4484" @change="saveHome" />
      </div>
      <div class="bn-field">
        <label :for="ids.lon">receiver longitude</label>
        <input :id="ids.lon" v-model="homeLon" type="text" inputmode="decimal" placeholder="-112.0740" @change="saveHome" />
      </div>
    </div>
    <p v-if="homeBad" class="bn-note" role="alert">
      that position does not parse. use decimal degrees, negative for south and west.
    </p>

    <div class="bn-subhead" style="margin-top: 14px">
      track from the receiver
      <span class="bn-aside">
        {{ centre ? `outer ring ${rangeKm} km` : 'set a receiver location to plot the track' }}
      </span>
    </div>
    <InstRadar :blips="blips" :range-label="centre ? `${rangeKm} km` : ''" :size="300" />

    <div class="bn-reads" style="margin-top: 12px">
      <div class="bn-read">
        <div class="bn-k">elevation</div>
        <div class="bn-v">{{ fix ? `${fix.elevation.toFixed(1)} deg` : '--' }}</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">ground speed</div>
        <div class="bn-v">{{ fmt(latest?.speed, 1, 'm/s') }}</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">heading</div>
        <div class="bn-v">{{ fmt(latest?.heading, 0, 'deg') }}</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">temperature</div>
        <div class="bn-v">{{ temperature }}</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">humidity</div>
        <div class="bn-v">uncalibrated</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">gps sats</div>
        <div class="bn-v">{{ latest?.sats ?? '--' }}</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">battery</div>
        <div class="bn-v">{{ fmt(latest?.battery, 1, 'v') }}</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">utc</div>
        <div class="bn-v">{{ latest?.time ? latest.time.slice(11, 19) : '--' }}</div>
      </div>
    </div>

    <div class="bn-subhead" style="margin-top: 14px">frames</div>
    <InstPacketList
      :packets="frames"
      :max="MAX_FRAMES"
      :empty-text="running ? 'no frame yet. an rs41 sends one a second once it is in range.' : 'press scan to start.'"
    />

    <div class="bn-hint">
      <HbIcon name="temperature-half" :size="15" />
      <div>
        <b>what it does</b>
        steps the radio across 400 to 406 mhz, holds the peak of each window, and follows the
        strongest signal shaped like a sonde. rs41 frames are gfsk at 4800 baud, descrambled,
        corrected with two reed-solomon codewords, and read for position, velocity and the
        temperature sensor once its calibration has come down. humidity needs a pressure
        correction this does not make, so it stays uncalibrated. national weather service sites
        launch at 00 and 12 utc, and a sonde at altitude is heard a few hundred km away.
      </div>
    </div>
  </div>
</template>

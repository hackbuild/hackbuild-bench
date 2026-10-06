<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstScope from '@/components/instruments/InstScope.vue'
import { TrunkFollower } from '@/core/scanner/p25/trunk'
import type { TrunkCall } from '@/core/scanner/p25/trunk'
import { DemoControlChannel } from '@/core/scanner/p25/demo'
import { P25Receiver } from '@/core/scanner/p25/receiver'
import { VoiceFollower } from '@/core/scanner/p25/voice'
import { AudioSink } from '@/core/audio/AudioSink'
import { useTranscription } from '@/composables/useTranscription'
import { findCodes, topCategory, CATEGORY_COLOR, CODE_BOOKS } from '@/core/scanner/codes'
import { useP25Keys } from '@/composables/useP25Keys'
import { ALGID_NAME, KEY_BYTES } from '@/core/scanner/p25/crypto'
import { floatsToWav } from '@/core/audio/wav'
import { HbInput, HbSelect } from '@virgilvox/hackbuild-ui'
import InstKnob from '@/components/instruments/InstKnob.vue'
import type { ParamSpec } from '@/core/types'
import type { P25Stats } from '@/core/scanner/p25/receiver'
import { bus } from '@/core/bus/DeviceBus'
import { allSystems, makeCustomSystem, regionsWithSystems, saveImportedSystems, loadImportedSystems } from '@/core/scanner/systems'
import { parseFrequency } from '@/core/dsp/spectrumMath'
import type { RadioSystem } from '@/core/scanner/systems'
import { SERVICE_LABELS } from '@/core/scanner/conventional'
import { fixedWindow, reaches } from '@/core/dsp/spectrumMath'
import { useDevices } from '@/stores/devices'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { useStreamLease } from '@/composables/useStreamLease'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { formatClock, formatHz } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const stream = useDeviceStream(props.deviceId)
const lease = useStreamLease(props.deviceId)

/** The control channel sits this far below the window centre, clear of the dc spike. */
const OFFSET_HZ = 300_000
const WANT_RATE = 2_400_000
/** A listed control frequency that shows no frame sync for this long is passed over. */
const HUNT_MS = 5000

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isDemo = computed(() => (node.value ? isSimKind(node.value.kind) : false))
const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const rateSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'sampleRate'))

const systems = ref(allSystems())
const regions = computed(() => regionsWithSystems())
const region = ref('Arizona')
const inRegion = computed(() => systems.value.filter((s) => s.region === region.value))
const systemId = ref('')
const siteIndex = ref(0)

// keep a system selected as the region changes.
watch(
  [region, systems],
  () => {
    if (!inRegion.value.some((s) => s.id === systemId.value)) systemId.value = inRegion.value[0]?.id ?? ''
  },
  { immediate: true },
)

// add a control channel for a system the directory lists without one, or a
// system of the operator's own.
const showAdd = ref(false)
const addName = ref('')
const addFreq = ref('')
const addError = ref<string | null>(null)
function addSystem(): void {
  addError.value = null
  const freqs = addFreq.value
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(parseFrequency)
  if (!freqs.length || freqs.some((f) => f === null)) {
    addError.value = 'give the control channel in mhz, for example 853.35. separate several with a comma.'
    return
  }
  const base = systems.value.find((x) => x.id === systemId.value && !x.sites.length)
  const sys = makeCustomSystem(addName.value, region.value, freqs as number[], base?.id)
  const imported = [...loadImportedSystems(), sys]
  saveImportedSystems(imported)
  systems.value = allSystems()
  systemId.value = sys.id
  siteIndex.value = 0
  controlIndex.value = 0
  showAdd.value = false
  addName.value = ''
  addFreq.value = ''
}
/** Which of the site's listed control frequencies is being tried. */
const controlIndex = ref(0)
const running = ref(false)
const calls = shallowRef<TrunkCall[]>([])
const identCount = ref(0)
const lock = ref<P25Stats | null>(null)
const serviceFilter = ref<string>('all')
const error = ref<string | null>(null)
/** Listed control frequencies tried without a sync, in this run. */
const triedSilent = ref(0)

const system = computed<RadioSystem | undefined>(() => systems.value.find((s) => s.id === systemId.value))
const site = computed(() => system.value?.sites[siteIndex.value])
const controlList = computed(() => site.value?.controlHz ?? [])
const controlHz = computed(() => controlList.value[controlIndex.value] ?? controlList.value[0] ?? 0)
/** A recording holds one window. Its centre and rate, when the device is one. */
const recording = computed(() => {
  const s = centerSpec.value
  const rate = node.value?.params.sampleRate ?? 0
  return s && fixedWindow(s, rate) ? { centerHz: s.min, rate } : null
})
/** Listed control frequencies a recording holds well inside its window. */
function inRecording(hz: number): boolean {
  const r = recording.value
  return !!r && Math.abs(hz - r.centerHz) < r.rate * 0.4
}
const reachable = computed(() => {
  if (isDemo.value) return true
  if (recording.value) return controlList.value.some(inRecording)
  return !centerSpec.value || controlList.value.some((hz) => reaches(centerSpec.value!, hz))
})

let follower: TrunkFollower | null = null
let demo: DemoControlChannel | null = null
let decoder: P25Receiver | null = null
let unsubscribe: (() => void) | null = null
let feedTimer: ReturnType<typeof setInterval> | null = null
let ageTimer: ReturnType<typeof setInterval> | null = null
let lastSyncs = 0
let lastSyncAt = 0

// ---------------------------------------------------------------------------
// voice: a clear phase 1 call inside the window plays while the control
// channel keeps being read.
// ---------------------------------------------------------------------------

/** Play calls as they come. */
const hear = ref(true)
const hearing = shallowRef<TrunkCall | null>(null)
/** Mirrors of the follower's decrypt state, for the status line. */
const decrypting = ref(false)
const encKeyId = ref(0)
/** A talkgroup picked from the list, heard ahead of anything else. */
const pinned = ref<number | null>(null)
const VOLUME: ParamSpec = { key: 'volume', label: 'volume', min: 0, max: 100, step: 1, default: 72 }
const volume = ref(VOLUME.default)
let sink: AudioSink | null = null
/** Where the radio's window is centred, so a voice channel's place in it is known. */
let windowCenter = 0
let windowRate = 0

const ears = useTranscription(props.deviceId)
const p25Keys = useP25Keys()
watch(p25Keys.keys, (ks) => voice.setKeys(ks), { deep: true })

// adding a key
const keyIdIn = ref('')
const keyAlg = ref(0xaa)
const keyIn = ref('')
const KEY_ALGS = [
  { label: 'adp (rc4)', value: 0xaa },
  { label: 'des-ofb', value: 0x81 },
  { label: 'aes-256', value: 0x84 },
]
function addKey(): void {
  if (p25Keys.add(keyIdIn.value, keyAlg.value, keyIn.value)) {
    keyIdIn.value = ''
    keyIn.value = ''
    voice.setKeys(p25Keys.keys.value)
  }
}
function keyHint(alg: number): string {
  return `${KEY_BYTES[alg]} bytes, ${KEY_BYTES[alg] * 2} hex digits`
}
function encName(alg: number): string {
  return ALGID_NAME[alg] ?? `alg 0x${alg.toString(16)}`
}

// saving call audio
const saveCalls = ref(false)
function saveClip(call: TrunkCall, clip: Float32Array, rate: number): void {
  if (clip.length < rate * 0.4) return
  const blob = floatsToWav(clip, rate)
  const name = `p25_${call.talkgroup}_${new Date(call.startedAt).toISOString().replace(/[:.]/g, '-')}.wav`
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  bus.emitDecoded(props.deviceId, { kind: 'blob', mime: 'audio/wav', name, bytes: new Uint8Array() })
}
/** Read codes out of what is said and tag the call. */
const readCodes = ref(true)
const codeBook = CODE_BOOKS[0]

/** A timestamped line for every call that was transcribed, newest first. */
interface LogLine {
  at: number
  talkgroup: number
  name: string
  hz: number
  category?: string
  codes: string[]
  text: string
}
const transcriptLog = ref<LogLine[]>([])
const MAX_LOG = 500

async function transcribeCall(call: TrunkCall, clip: Float32Array, rate: number): Promise<void> {
  if (!readCodes.value || !ears.ready.value || clip.length < rate * 0.6) return
  const text = (await ears.transcribeClip(clip, rate)).trim()
  if (!text) return
  const found = findCodes(text, codeBook)
  const live = calls.value.find((c) => c.id === call.id)
  if (!live) return
  live.transcript = text
  if (found.length) {
    live.codes = found
    live.category = topCategory(found) ?? undefined
  }
  transcriptLog.value = [
    {
      at: call.startedAt,
      talkgroup: call.talkgroup,
      name: call.name,
      hz: call.hz,
      category: live.category,
      codes: found.map((h) => h.code),
      text,
    },
    ...transcriptLog.value,
  ].slice(0, MAX_LOG)
}

function clearLog(): void {
  transcriptLog.value = []
}

/** The log as plain text, newest last, for saving. */
function saveLog(): void {
  const lines = [...transcriptLog.value].reverse().map((l) => {
    const t = new Date(l.at).toISOString().replace('T', ' ').slice(0, 19)
    const cat = l.category ? ` [${l.category}]` : ''
    const codes = l.codes.length ? ` (${l.codes.join(', ')})` : ''
    return `${t}  ${l.name} tg ${l.talkgroup} ${(l.hz / 1e6).toFixed(5)} mhz${cat}${codes}: ${l.text}`
  })
  const head = `hackbuild bench, p25 transcript log, ${system.value?.name ?? ''}\n\n`
  const blob = new Blob([head + lines.join('\n') + '\n'], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `p25_log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
  a.click()
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

const voice = new VoiceFollower(
  (samples, rate) => {
    sink?.push(samples, rate)
    bus.emitAudio(props.deviceId, samples.slice(), rate)
    decrypting.value = voice.decrypting
    encKeyId.value = voice.encKeyId
  },
  (clip, rate) => {
    const c = hearing.value
    hearing.value = null
    decrypting.value = false
    if (c && clip.length) {
      void transcribeCall(c, clip, rate)
      if (saveCalls.value) saveClip(c, clip, rate)
    }
    pickCall()
  },
  () => {
    // the grant said clear but the voice says otherwise, so the call is marked and passed over.
    const c = hearing.value
    if (c) c.encrypted = true
    calls.value = [...calls.value]
  },
)

/** Why a call cannot be heard, or an empty string when it can. */
function blocked(c: TrunkCall): string {
  if (c.encrypted) return 'encrypted'
  if (c.phase2) return 'phase 2, whose ambe+2 voice is still under patent and not decoded here'
  if (!windowRate || Math.abs(c.hz - windowCenter) > windowRate * 0.42) return 'outside the window the radio holds'
  return ''
}

/** The call to hear next: the pinned talkgroup first, then the newest that passes the filter. */
function pickCall(): void {
  if (!hear.value || voice.active || !running.value || isDemo.value) return
  const live = calls.value.filter((c) => c.endedAt === null && !blocked(c))
  const wanted = live.filter((c) => serviceFilter.value === 'all' || c.service === serviceFilter.value)
  const next = live.find((c) => c.talkgroup === pinned.value) ?? wanted[0]
  if (!next) return
  hearing.value = next
  // the control channel's measured error, scaled to the voice channel's frequency.
  const errorHz = (lock.value?.offsetHz ?? 0) * (next.hz / (controlHz.value || next.hz))
  voice.follow(next.hz - windowCenter, errorHz)
}

function pin(c: TrunkCall): void {
  pinned.value = pinned.value === c.talkgroup ? null : c.talkgroup
  if (pinned.value !== null && hearing.value && hearing.value.talkgroup !== pinned.value) voice.end()
  else pickCall()
}

function toggleHear(): void {
  hear.value = !hear.value
  if (!hear.value) {
    voice.stop()
    hearing.value = null
  } else pickCall()
}

watch(volume, (v) => sink?.setVolume(v / 100))

const filtered = computed(() => {
  if (serviceFilter.value === 'all') return calls.value
  return calls.value.filter((c) => c.service === serviceFilter.value)
})

const active = computed(() => calls.value.filter((c) => c.endedAt === null).slice(0, 6))

/** The highest offered rate at or under the one wanted. */
function scanRate(): number {
  const s = rateSpec.value
  if (!s?.choices?.length) return s ? Math.min(s.max, Math.max(s.min, WANT_RATE)) : WANT_RATE
  const under = s.choices.filter((r) => r <= WANT_RATE)
  return under.length ? Math.max(...under) : Math.min(...s.choices)
}

/** Parks the radio so the control channel sits off the window centre, and points the decoder at it. */
async function tuneControl(): Promise<void> {
  const r = recording.value
  if (r) {
    // a recording cannot retune, so the decoder looks where the channel already is.
    if (!inRecording(controlHz.value)) controlIndex.value = Math.max(0, controlList.value.findIndex(inRecording))
    decoder?.setOffset(controlHz.value - r.centerHz)
    windowCenter = r.centerHz
    windowRate = r.rate
    lastSyncAt = Date.now()
    lastSyncs = lock.value?.syncs ?? 0
    return
  }
  const hz = controlHz.value
  decoder?.setOffset(-OFFSET_HZ)
  lastSyncAt = Date.now()
  lastSyncs = lock.value?.syncs ?? 0
  windowCenter = hz + OFFSET_HZ
  windowRate = scanRate()
  voice.stop()
  hearing.value = null
  await devices.configure(props.deviceId, { centerHz: windowCenter, sampleRate: windowRate })
}

/**
 * A system moves its control channel among the frequencies it lists, so a
 * silent one is passed over for the next, the way a scanner hunts.
 */
async function hunt(): Promise<void> {
  const s = decoder?.getStats()
  if (!s) return
  lock.value = s
  if (s.syncs !== lastSyncs) {
    lastSyncs = s.syncs
    lastSyncAt = Date.now()
    triedSilent.value = 0
    return
  }
  if (Date.now() - lastSyncAt < HUNT_MS || controlList.value.length < 2 || recording.value) return
  triedSilent.value = Math.min(controlList.value.length, triedSilent.value + 1)
  controlIndex.value = (controlIndex.value + 1) % controlList.value.length
  follower?.flushIdentifiers()
  await tuneControl()
}

async function start(): Promise<void> {
  const sys = system.value
  if (!sys || !controlHz.value) return
  error.value = null
  triedSilent.value = 0

  follower = new TrunkFollower(sys, {
    onCall: () => {
      calls.value = follower ? [...follower.callLog] : []
      pickCall()
    },
    onCallEnd: () => {
      calls.value = follower ? [...follower.callLog] : []
    },
    onStatus: () => undefined,
    onIdent: (n) => {
      identCount.value = n
    },
  })
  ageTimer = setInterval(() => follower?.tick(), 1000)
  running.value = true

  if (isDemo.value) {
    // in demo the control channel is synthetic, so grants flow immediately.
    demo = new DemoControlChannel(sys)
    feedTimer = setInterval(() => {
      if (demo && follower) follower.feedTsbk(demo.next())
    }, 260)
    return
  }

  const t = lease.begin()
  try {
    // playback needs the press that started it, so the sink opens first.
    sink ??= new AudioSink()
    await sink.resume()
    sink.setVolume(volume.value / 100)
    if (readCodes.value) void ears.enable()
    voice.setKeys(p25Keys.keys.value)
    decoder = new P25Receiver({ onTsbk: (octets) => follower?.feedTsbk(octets) })
    unsubscribe = bus.onDeviceArtifact(props.deviceId, (a) => {
      if (a.kind !== 'iq') return
      decoder?.feed(a.samples, a.sampleRate)
      voice.feed(a.samples, a.sampleRate)
    })
    await tuneControl()
    if (!lease.current(t)) return
    if (!(await lease.stream(t))) return
    feedTimer = setInterval(() => void hunt(), 500)
  } catch (err) {
    if (!lease.current(t)) return
    error.value = err instanceof Error ? err.message.toLowerCase() : String(err)
    await stop()
  }
}

async function stop(): Promise<void> {
  running.value = false
  if (feedTimer) clearInterval(feedTimer)
  if (ageTimer) clearInterval(ageTimer)
  feedTimer = ageTimer = null
  demo = null
  unsubscribe?.()
  unsubscribe = null
  decoder = null
  voice.stop()
  hearing.value = null
  lock.value = null
  await lease.release()
}

/** What the decoder hears, in words. */
const verdict = computed(() => {
  const s = lock.value
  if (!running.value || isDemo.value || !s) return ''
  if (s.good > 0) return `decoding. ${s.good} control blocks read.`
  if (s.syncs > 0) return 'p25 frames heard, but no block has passed its check yet. the signal is weak or smeared.'
  if (s.stage === 'acquire') {
    return `looking for a signal within 15 khz of ${formatHz(controlHz.value, 5)}. the strongest lump stands ${Math.max(0, s.signalDb).toFixed(0)} db over the floor.`
  }
  if (triedSilent.value >= controlList.value.length && controlList.value.length > 1) {
    return 'no p25 on any listed control frequency. the antenna may not reach the site, or the list is out of date.'
  }
  return `found a signal ${Math.round(s.offsetHz)} hz from ${formatHz(controlHz.value, 5)}, listening for p25 frames.`
})

/** A carrier this far off is the radio's crystal, which the tv tab can measure and correct. */
const ppmHint = computed(() => {
  const s = lock.value
  if (!s || s.stage !== 'decode' || Math.abs(s.offsetHz) < 2500 || !controlHz.value) return ''
  const ppm = (s.offsetHz / controlHz.value) * 1e6
  return `the carrier sits ${Math.abs(ppm).toFixed(1)} ppm off, which is this radio's crystal. the crystal check on the tv tab measures and sets the correction.`
})

const SERVICES = ['all', 'fire', 'law', 'ems', 'interop']

onBeforeUnmount(() => {
  void stop()
  void sink?.close()
  sink = null
})
</script>

<template>
  <div>
    <p class="bn-note" style="margin-top: 0">
      a trunked system moves each conversation across a pool of frequencies. the bench
      watches the control channel, reads which talkgroup moved where, and shows it live.
    </p>

    <div class="bn-knobs" style="margin-top: 0">
      <div class="bn-knob" style="min-width: 140px">
        <span class="bn-klabel">state</span>
        <select v-model="region" :disabled="running">
          <option v-for="r in regions" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>
      <div class="bn-knob" style="min-width: 240px">
        <span class="bn-klabel">system</span>
        <select v-model="systemId" :disabled="running" @change="siteIndex = 0; controlIndex = 0">
          <option v-for="s in inRegion" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
      </div>
      <div class="bn-knob" style="min-width: 200px" v-if="system && system.sites.length">
        <span class="bn-klabel">site</span>
        <select v-model.number="siteIndex" :disabled="running" @change="controlIndex = 0">
          <option v-for="(s, i) in system.sites" :key="s.id" :value="i">{{ s.name }}</option>
        </select>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton v-if="!running" variant="danger" size="sm" :disabled="!controlHz || !reachable" @click="start">
          <template #icon><HbIcon name="tower-cell" /></template>
          watch control
        </HbButton>
        <HbButton v-else size="sm" @click="stop">
          <template #icon><HbIcon name="stop" /></template>
          stop
        </HbButton>
      </div>
    </div>

    <div v-if="system && !system.sites.length" class="bn-note tr-tight">
      this system is in the directory by name only. its control channel changes and is not
      bundled. find it for your area on
      <a class="bn-linkish" href="https://www.radioreference.com/db/aliases/trs" target="_blank" rel="noopener">radioreference</a>,
      then
      <button type="button" class="bn-linkish" @click="showAdd = !showAdd">add the control channel</button>.
    </div>
    <div v-else class="bn-note tr-tight">
      <button type="button" class="bn-linkish" @click="showAdd = !showAdd">add another system or control channel</button>.
      only the states with a bundled or added system appear. for the full directory see
      <a class="bn-linkish" href="https://www.radioreference.com/db/aliases/trs" target="_blank" rel="noopener">radioreference</a>.
    </div>

    <form v-if="showAdd" class="bn-goto tr-addsys" @submit.prevent="addSystem">
      <HbInput v-model="addName" :placeholder="system?.name ?? 'system name'" aria-label="system name" />
      <HbInput v-model="addFreq" placeholder="control mhz, eg 853.35" aria-label="control channel frequency" />
      <HbButton size="sm" type="submit">add</HbButton>
    </form>
    <p v-if="addError" class="bn-note" role="alert">{{ addError }}</p>

    <div class="bn-meta">
      <div>
        <div class="bn-k">control</div>
        <div class="bn-v">{{ formatHz(controlHz, 5) }}</div>
      </div>
      <div>
        <div class="bn-k">identifiers</div>
        <div class="bn-v">{{ identCount }}</div>
      </div>
      <div>
        <div class="bn-k">active</div>
        <div class="bn-v">{{ active.length }}</div>
      </div>
      <div>
        <div class="bn-k">calls</div>
        <div class="bn-v">{{ calls.length }}</div>
      </div>
      <div v-if="system?.wacn">
        <div class="bn-k">wacn</div>
        <div class="bn-v">{{ system.wacn }}</div>
      </div>
    </div>

    <InstScope :bins="stream.fft.value" :height="110" ruled :demo="!running && isDemo" />

    <p v-if="!reachable && recording" class="bn-note" role="alert">
      this recording does not hold any of this site's control frequencies.
    </p>
    <p v-else-if="!reachable" class="bn-note" role="alert">
      this tuner does not reach {{ formatHz(controlHz, 5) }}, so it cannot hear this site.
    </p>
    <p v-if="error" class="bn-note" role="alert">{{ error }}</p>
    <div class="tr-live" role="status">
      <p v-if="verdict" class="bn-note">{{ verdict }}</p>
    </div>
    <p v-if="ppmHint" class="bn-note">{{ ppmHint }}</p>

    <div v-if="!isDemo && running" class="bn-reads tr-reads">
      <div class="bn-read">
        <div class="bn-k">sync</div>
        <div class="bn-v" :class="{ 'is-pink': (lock?.syncs ?? 0) > 0 }">
          {{ lock?.syncs ?? 0 }}
        </div>
      </div>
      <div class="bn-read">
        <div class="bn-k">blocks</div>
        <div class="bn-v" :class="{ 'is-pink': (lock?.good ?? 0) > 0 }">
          {{ lock?.good ?? 0 }} good, {{ lock?.bad ?? 0 }} bad
        </div>
      </div>
      <div class="bn-read">
        <div class="bn-k">nac</div>
        <div class="bn-v">
          {{ lock?.nac === null || lock?.nac === undefined ? 'none yet' : '0x' + lock.nac.toString(16) }}
        </div>
      </div>
      <div class="bn-read">
        <div class="bn-k">eye</div>
        <div class="bn-v">{{ ((1 - (lock?.errorRate ?? 1)) * 100).toFixed(0) }}%</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">carrier off by</div>
        <div class="bn-v">{{ lock ? `${Math.round(lock.offsetHz)} hz` : '--' }}</div>
      </div>
    </div>

    <div v-if="!isDemo" class="bn-knobs tr-voice">
      <button type="button" class="bn-pack" :class="{ 'is-on': hear }" :aria-pressed="hear" @click="toggleHear">
        hear calls
      </button>
      <button type="button" class="bn-pack" :class="{ 'is-on': readCodes }" :aria-pressed="readCodes" @click="readCodes = !readCodes">
        read codes
      </button>
      <button type="button" class="bn-pack" :class="{ 'is-on': saveCalls }" :aria-pressed="saveCalls" @click="saveCalls = !saveCalls">
        save calls
      </button>
      <InstKnob v-model="volume" :spec="VOLUME" />
      <div class="tr-hearing" role="status">
        <template v-if="hearing">
          hearing {{ hearing.name }} on {{ formatHz(hearing.hz, 5) }}
          <span v-if="decrypting">, decrypting with key 0x{{ encKeyId.toString(16) }}</span>
        </template>
        <template v-else-if="running && hear">waiting for a call this radio can play</template>
      </div>
    </div>

    <details v-if="!isDemo" class="tr-keys">
      <summary class="bn-note">encryption keys ({{ p25Keys.keys.value.length }} loaded)</summary>
      <p class="bn-note tr-tight">
        load a key your agency issued you and this tool will play that key's calls, the same as
        your own radio. keys stay in this browser. this does not break encryption or find keys.
      </p>
      <div v-for="k in p25Keys.keys.value" :key="k.keyId" class="tr-keyrow">
        <span class="bn-b">key 0x{{ k.keyId.toString(16) }}</span>
        <span>{{ encName(k.algid) }}</span>
        <span>{{ k.key.length }} bytes</span>
        <button type="button" class="bn-tinyact" @click="p25Keys.remove(k.keyId)">remove</button>
      </div>
      <form class="bn-goto tr-addkey" @submit.prevent="addKey">
        <HbInput v-model="keyIdIn" placeholder="key id, eg 2" aria-label="key id in hex" />
        <HbSelect v-model="keyAlg" :options="KEY_ALGS" aria-label="algorithm" />
        <HbInput v-model="keyIn" :placeholder="keyHint(keyAlg)" aria-label="key in hex" />
        <HbButton size="sm" type="submit">add key</HbButton>
      </form>
      <p v-if="p25Keys.error.value" class="bn-note" role="alert">{{ p25Keys.error.value }}</p>
    </details>
    <p v-if="!isDemo" class="bn-note tr-tight">
      clear phase 1 calls inside the radio's window play here, read by an imbe vocoder. phase 2
      calls use ambe+2, which is under patent until may 2028, and stay silent, as do encrypted
      ones. pick a talkgroup below to hear it first.
    </p>

    <div class="bn-subhead" style="margin-top: 14px">
      talkgroup activity
      <span class="bn-grow"></span>
      <button
        v-for="s in SERVICES"
        :key="s"
        type="button"
        class="bn-tinyact"
        :aria-pressed="serviceFilter === s"
        @click="serviceFilter = s"
      >
        {{ s }}
      </button>
    </div>

    <div class="bn-list">
      <div
        v-for="c in filtered.slice(0, 60)"
        :key="c.id"
        class="bn-row"
        :class="{ 'is-alert': c.emergency }"
      >
        <span class="bn-a">{{ c.name }}</span>
        <span class="bn-b">
          {{ SERVICE_LABELS[c.service as keyof typeof SERVICE_LABELS] ?? c.service }}
          <template v-if="c.encrypted"> (encrypted)</template>
        </span>
        <span class="bn-c">{{ c.endedAt === null ? 'live' : formatClock(c.startedAt) }}</span>
        <div class="bn-decode">
          {{ formatHz(c.hz, 5) }}<template v-if="c.source"> from unit {{ c.source }}</template>
          <span v-if="c.category" class="tr-cat" :style="{ color: CATEGORY_COLOR[c.category] }">{{ c.category }}</span>
          <template v-if="!isDemo">
            <span v-if="hearing?.id === c.id" class="tr-on"> hearing now</span>
            <span v-else-if="blocked(c)"> {{ blocked(c) }}</span>
            <button
              v-if="!blocked(c)"
              type="button"
              class="bn-tinyact tr-pin"
              :aria-pressed="pinned === c.talkgroup"
              @click="pin(c)"
            >
              {{ pinned === c.talkgroup ? 'pinned' : 'hear first' }}
            </button>
          </template>
          <div v-if="c.codes?.length" class="tr-codes">
            <span v-for="h in c.codes" :key="h.code">{{ h.code }} {{ h.meaning }}</span>
          </div>
          <div v-if="c.transcript" class="tr-tx">"{{ c.transcript }}"</div>
        </div>
      </div>
      <div v-if="!filtered.length" class="bn-row">
        <span class="bn-b">
          {{ running ? 'control channel is quiet. a healthy decoder can still see zero calls when the system is idle.' : 'pick a system and press watch control.' }}
        </span>
      </div>
    </div>

    <p class="bn-note">
      encrypted talkgroups show as active but produce no audio. most arizona law tactical
      is encrypted; fire dispatch and the interop channels are usually in the clear.
    </p>

    <div v-if="!isDemo" class="bn-subhead tr-loghead">
      transcript log
      <span class="bn-aside">{{ transcriptLog.length }} calls, newest first</span>
      <span class="bn-grow"></span>
      <button type="button" class="bn-tinyact" :disabled="!transcriptLog.length" @click="saveLog">save</button>
      <button type="button" class="bn-tinyact" :disabled="!transcriptLog.length" @click="clearLog">clear</button>
    </div>
    <div v-if="!isDemo" class="tr-log">
      <div v-for="(l, i) in transcriptLog" :key="i" class="tr-logline">
        <span class="tr-logt">{{ new Date(l.at).toLocaleTimeString() }}</span>
        <span class="tr-logtg">{{ l.name }}</span>
        <span v-if="l.category" class="tr-cat" :style="{ color: CATEGORY_COLOR[l.category as keyof typeof CATEGORY_COLOR] }">{{ l.category }}</span>
        <span class="tr-logtx">{{ l.text }}</span>
      </div>
      <div v-if="!transcriptLog.length" class="bn-note tr-tight">
        turn on read codes and the calls you hear are transcribed here with the time, the
        talkgroup and what it was about.
      </div>
    </div>
  </div>
</template>

<style scoped>
.tr-reads {
  margin-top: var(--hb-s3);
}
.tr-voice {
  align-items: center;
}
.tr-hearing {
  font-family: var(--hb-utility);
  font-size: 11px;
  color: var(--hb-ink-2);
}
.tr-tight {
  margin-top: 0;
}
.tr-addsys {
  margin-top: var(--hb-s2);
}
.tr-keys {
  margin: var(--hb-s3) 0;
}
.tr-keys > summary {
  cursor: pointer;
}
.tr-keyrow {
  display: flex;
  gap: var(--hb-s3);
  align-items: center;
  font-family: var(--hb-utility);
  font-size: 11px;
  margin: var(--hb-s1) 0;
}
.tr-addkey {
  margin-top: var(--hb-s2);
}
.tr-on {
  font-weight: 700;
}
.tr-pin {
  margin-left: var(--hb-s2);
}
.tr-loghead {
  margin-top: var(--hb-s4);
}
.tr-log {
  border: var(--hb-border) solid var(--hb-ink);
  background: var(--hb-paper-raised);
  max-height: 320px;
  overflow-y: auto;
}
.tr-logline {
  display: flex;
  gap: var(--hb-s2);
  align-items: baseline;
  flex-wrap: wrap;
  padding: var(--hb-s1) var(--hb-s3);
  border-bottom: 1px solid var(--hb-paper-edge);
  font-size: 12px;
}
.tr-logline:last-child {
  border-bottom: 0;
}
.tr-logt {
  font-family: var(--hb-readout);
  color: var(--hb-ink-3);
}
.tr-logtg {
  font-family: var(--hb-utility);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--hb-ink-2);
}
.tr-logtx {
  font-family: var(--hb-body);
  color: var(--hb-ink);
  flex: 1 1 60%;
}
</style>
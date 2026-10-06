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
import InstKnob from '@/components/instruments/InstKnob.vue'
import type { ParamSpec } from '@/core/types'
import type { P25Stats } from '@/core/scanner/p25/receiver'
import { bus } from '@/core/bus/DeviceBus'
import { allSystems } from '@/core/scanner/systems'
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

const systems = allSystems()
const systemId = ref(systems[0]?.id ?? '')
const siteIndex = ref(0)
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

const system = computed<RadioSystem | undefined>(() => systems.find((s) => s.id === systemId.value))
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
/** A talkgroup picked from the list, heard ahead of anything else. */
const pinned = ref<number | null>(null)
const VOLUME: ParamSpec = { key: 'volume', label: 'volume', min: 0, max: 100, step: 1, default: 72 }
const volume = ref(VOLUME.default)
let sink: AudioSink | null = null
/** Where the radio's window is centred, so a voice channel's place in it is known. */
let windowCenter = 0
let windowRate = 0

const voice = new VoiceFollower(
  (samples, rate) => {
    sink?.push(samples, rate)
    bus.emitAudio(props.deviceId, samples.slice(), rate)
  },
  () => {
    hearing.value = null
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
      <div class="bn-knob" style="min-width: 240px">
        <span class="bn-klabel">system</span>
        <select v-model="systemId" :disabled="running" @change="siteIndex = 0; controlIndex = 0">
          <option v-for="s in systems" :key="s.id" :value="s.id">{{ s.name }}</option>
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

    <div v-if="system && !system.sites.length" class="bn-banner is-warn">
      <HbIcon name="warning" />
      <span>
        this system has no control channel frequency bundled, and this build has no way
        to add one. pick a system that has sites listed.
      </span>
    </div>

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
      <InstKnob v-model="volume" :spec="VOLUME" />
      <div class="tr-hearing" role="status">
        <template v-if="hearing">
          hearing {{ hearing.name }} on {{ formatHz(hearing.hz, 5) }}
        </template>
        <template v-else-if="running && hear">waiting for a clear phase 1 call inside the window</template>
      </div>
    </div>
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
.tr-on {
  font-weight: 700;
}
.tr-pin {
  margin-left: var(--hb-s2);
}
</style>

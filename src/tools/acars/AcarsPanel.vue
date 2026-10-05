<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { HbButton, HbIcon, HbInput, HbSelect } from '@virgilvox/hackbuild-ui'
import InstPacketList from '@/components/instruments/InstPacketList.vue'
import { bus } from '@/core/bus/DeviceBus'
import { useDevices } from '@/stores/devices'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { formatClock } from '@/core/format'
import { fixedWindow, parseFrequency, reaches, spansOf } from '@/core/dsp/spectrumMath'
import { AcarsDecoder, GUARD_HZ, PLANS, centerFor, rateFor } from '@/core/decode/acars'
import type { AcarsMessage, ChannelStats } from '@/core/decode/acars'
import { AcarsDemoSource } from '@/core/decode/acars/demo'
import type { Artifact, IqChunk } from '@/core/types'
import type { DeviceToolProps } from '@/tools/types'
import { useStreamLease } from '@/composables/useStreamLease'

const props = defineProps<DeviceToolProps>()
const devices = useDevices()
const lease = useStreamLease(props.deviceId)
const ids = { plan: useId(), add: useId(), find: useId(), chan: useId() }

const MAX = 300
/** Rates tried when a radio gives a range rather than a list. */
const CANDIDATE_RATES = [2_400_000, 2_880_000, 3_200_000, 4_000_000, 8_000_000, 10_000_000]
/** Manual gain that suits airband on an rtl-sdr without overloading on fm. */
const GAIN_DB = 40
/** Past this with nothing decoded, the panel says so. */
const QUIET_S = 90
const AIRBAND: [number, number] = [118_000_000, 137_000_000]

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isSim = computed(() => isSimKind(node.value?.kind ?? ''))
const tuner = computed(() => (node.value?.info.tuner ?? node.value?.descriptor.name ?? 'radio').toLowerCase())
/** What the attached device calls itself, for copy that names it. */
const deviceName = computed(() => (node.value?.label ?? node.value?.descriptor.name ?? 'radio').toLowerCase())
const spec = (key: string) => node.value?.descriptor.params.find((p) => p.key === key)

const planName = ref(PLANS[0].name)
const enabled = ref<number[]>([...PLANS[0].channelsHz])
const extra = ref<number[]>([])
const typed = ref('')
const typedError = ref<string | null>(null)

const plan = computed(() => PLANS.find((p) => p.name === planName.value) ?? PLANS[0])
const offered = computed(() => [...new Set([...plan.value.channelsHz, ...extra.value])].sort((a, b) => a - b))
const channels = computed(() => offered.value.filter((f) => enabled.value.includes(f)))

const rates = computed(() => {
  const s = spec('sampleRate')
  if (!s) return CANDIDATE_RATES
  return s.choices?.length ? s.choices : CANDIDATE_RATES.filter((r) => r >= s.min && r <= s.max)
})

const mhz = (hz: number): string => (hz / 1e6).toFixed(3)
const msps = (r: number): string => `${(r / 1e6).toFixed(r % 1e5 ? 3 : 2)} msps`

/** Room left at a recording's edges for a 2400 baud channel's filter. */
const RECORDING_GUARD_HZ = 15_000

/** A recording cannot retune, so its own centre and rate are the only window there is. */
const recordingWindow = computed(() => {
  const c = spec('centerHz')
  return c ? fixedWindow(c, node.value?.params.sampleRate ?? 0, RECORDING_GUARD_HZ) : null
})

const layout = computed(() => {
  const w = recordingWindow.value
  const c = spec('centerHz')
  if (w && c) return { rate: node.value?.params.sampleRate ?? 0, center: c.min }
  const rate = rateFor(channels.value, rates.value)
  if (!rate) return null
  const center = centerFor(channels.value, rate)
  return center === null ? null : { rate, center }
})

const problem = computed<string | null>(() => {
  if (isSim.value) return null
  if (!channels.value.length) return 'no channels on. turn at least one on.'
  const w = recordingWindow.value
  if (w) {
    const out = channels.value.filter((f) => f < w[0] || f > w[1])
    if (out.length) {
      return `this recording holds ${mhz(w[0])} to ${mhz(w[1])} mhz. turn off ${out.map(mhz).join(', ')}.`
    }
    return null
  }
  const c = spec('centerHz')
  if (c) {
    const far = channels.value.filter((f) => !reaches(c, f))
    if (far.length) {
      const span = spansOf(c).map(([a, b]) => `${mhz(a)} to ${mhz(b)}`).join(' and ')
      return `no tuner reaches ${far.map(mhz).join(', ')} mhz. the ${tuner.value} covers ${span} mhz.`
    }
  }
  if (!layout.value) {
    const span = Math.max(...channels.value) - Math.min(...channels.value)
    const top = Math.max(...rates.value)
    return `these channels span ${mhz(span)} mhz, wider than the ${msps(top)} window this radio offers. turn one off.`
  }
  if (c && !reaches(c, layout.value.center)) return `the window centre ${mhz(layout.value.center)} mhz is out of the ${tuner.value}'s range.`
  return null
})

/** The channels a recording holds, or all of them on a radio that tunes. */
function inWindow(chans: number[]): number[] {
  const w = recordingWindow.value
  return w ? chans.filter((f) => f >= w[0] && f <= w[1]) : chans
}

// a recording opens with only the channels it actually holds turned on.
watch(
  recordingWindow,
  (w) => {
    if (w) enabled.value = inWindow(offered.value)
  },
  { immediate: true },
)

function setPlan(name: string | number): void {
  planName.value = String(name)
  enabled.value = inWindow([...plan.value.channelsHz, ...extra.value])
}

function toggle(f: number): void {
  enabled.value = enabled.value.includes(f) ? enabled.value.filter((x) => x !== f) : [...enabled.value, f]
}

function addChannel(): void {
  typedError.value = null
  const raw = parseFrequency(typed.value)
  const hz = raw !== null && raw < 1e4 ? raw * 1e6 : raw
  if (hz === null || !Number.isFinite(hz)) {
    typedError.value = 'that does not parse as a frequency. type it in mhz, like 131.725.'
    return
  }
  const snapped = Math.round(hz / 12_500) * 12_500
  if (snapped < AIRBAND[0] || snapped > AIRBAND[1]) {
    typedError.value = `${mhz(snapped)} mhz is outside the vhf airband, 118 to 137 mhz.`
    return
  }
  if (!extra.value.includes(snapped)) extra.value = [...extra.value, snapped]
  if (!enabled.value.includes(snapped)) enabled.value = [...enabled.value, snapped]
  typed.value = ''
}

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

const running = ref(false)
const demo = ref(false)
const error = ref<string | null>(null)
const mismatch = ref<string | null>(null)
const messages = ref<AcarsMessage[]>([])
const stats = ref<ChannelStats[]>([])
const loadPct = ref(0)
const dropped = ref(0)
const listening = shallowRef<{ center: number; rate: number; channels: number[] } | null>(null)
const startedAt = ref(0)
const now = ref(Date.now())

let decoder: AcarsDecoder | null = null
let busyMs = 0
let airS = 0
let demoSource: AcarsDemoSource | null = null
let demoTimer = 0
let tick = 0
let lastDemo = 0

function build(center: number, rate: number, chans: number[]): void {
  decoder = new AcarsDecoder({ centerHz: center, sampleRate: rate, channelsHz: chans })
  decoder.onMessage = onMessage
  listening.value = { center, rate, channels: chans }
  stats.value = decoder.stats.map((s) => ({ ...s }))
}

function onMessage(m: AcarsMessage): void {
  messages.value = [m, ...messages.value].slice(0, MAX)
  // demo traffic stays in the panel, so the session log and automations see only real air.
  if (demo.value) return
  const who = m.registration || 'no registration'
  bus.emitDecoded(props.deviceId, {
    kind: 'packet',
    proto: 'acars',
    bytes: m.bytes,
    channel: m.channel,
    rssi: m.levelDb,
    summary: `${who} ${m.flight} ${m.label} ${m.text.slice(0, 60)}`.replace(/\s+/g, ' ').trim(),
    fields: {
      frequencyHz: m.freqHz,
      mode: m.mode,
      registration: m.registration,
      ack: m.ack ?? 'nak',
      label: m.label,
      labelName: m.labelName,
      blockId: m.blockId,
      msgNo: m.msgNo,
      flight: m.flight,
      text: m.text,
      downlink: m.downlink,
      end: m.end,
      corrected: m.corrected,
    },
  })
}

const stopBus = bus.onDeviceArtifact(props.deviceId, (a: Artifact) => {
  if (!running.value || demo.value || a.kind !== 'iq') return
  const c = a as IqChunk
  dropped.value += c.dropped
  const want = listening.value
  if (!want) return
  if (!decoder || decoder.centerHz !== c.centerHz || decoder.sampleRate !== c.sampleRate) {
    const half = c.sampleRate / 2 - GUARD_HZ
    const outside = want.channels.filter((f) => Math.abs(f - c.centerHz) > half)
    if (outside.length) {
      mismatch.value = `the radio is streaming ${mhz(c.centerHz)} mhz at ${msps(c.sampleRate)}, not the ${msps(want.rate)} window asked for, which leaves ${outside.map(mhz).join(', ')} mhz outside it.`
      decoder = null
      return
    }
    mismatch.value = null
    build(c.centerHz, c.sampleRate, want.channels)
  }
  const t0 = performance.now()
  decoder?.feed(c.samples)
  busyMs += performance.now() - t0
  airS += c.samples.length / 2 / c.sampleRate
})

function refresh(): void {
  now.value = Date.now()
  if (decoder) stats.value = decoder.stats.map((s) => ({ ...s }))
  if (airS > 0.5) {
    loadPct.value = (busyMs / (airS * 1000)) * 100
    busyMs = 0
    airS = 0
  }
}

async function start(): Promise<void> {
  // the channel counts start again with the decoder, so the list does too.
  messages.value = []
  error.value = null
  mismatch.value = null
  dropped.value = 0
  busyMs = 0
  airS = 0
  startedAt.value = Date.now()
  if (isSim.value) {
    startDemo()
    tick = window.setInterval(refresh, 500)
    return
  }
  const w = layout.value
  if (problem.value || !w) {
    error.value = problem.value
    return
  }
  const chans = [...channels.value]
  const next: Record<string, number> = { centerHz: w.center, sampleRate: w.rate }
  const g = spec('gain')
  if (g) {
    const manualTop = g.topLabel ? g.max - 1 : g.max
    next.gain = Math.max(g.min, Math.min(manualTop, GAIN_DB))
  }
  const t = lease.begin()
  running.value = true
  listening.value = { center: w.center, rate: w.rate, channels: chans }
  decoder = null
  stats.value = chans.map((f) => ({ freqHz: f, messages: 0, rejected: 0, levelDb: -120 }))
  try {
    await devices.configure(props.deviceId, next)
    if (!lease.current(t)) return
    if (!(await lease.stream(t))) return
  } catch (err) {
    if (!lease.current(t)) return
    running.value = false
    error.value = err instanceof Error ? err.message : String(err)
    void lease.release()
    return
  }
  clearInterval(tick)
  tick = window.setInterval(refresh, 500)
}

function startDemo(): void {
  const chans = PLANS[0].channelsHz
  const rate = 2_880_000
  const center = centerFor(chans, rate) ?? 130_344_000
  demoSource = new AcarsDemoSource(center, rate, chans)
  build(center, rate, chans)
  demo.value = true
  running.value = true
  lastDemo = performance.now()
  demoTimer = window.setInterval(() => {
    const src = demoSource
    if (!src || !decoder) return
    const t = performance.now()
    // sized from the clock, so a throttled background tab keeps real time.
    const dt = Math.min(0.5, (t - lastDemo) / 1000)
    lastDemo = t
    if (dt <= 0) return
    const iq = src.read(dt)
    const t0 = performance.now()
    decoder.feed(iq)
    busyMs += performance.now() - t0
    airS += dt
  }, 50)
}

async function stop(): Promise<void> {
  if (demoTimer) clearInterval(demoTimer)
  if (tick) clearInterval(tick)
  demoTimer = 0
  tick = 0
  demoSource = null
  demo.value = false
  running.value = false
  await lease.release()
}

function clear(): void {
  messages.value = []
  if (decoder) for (const s of decoder.stats) {
    s.messages = 0
    s.rejected = 0
  }
  refresh()
}

onBeforeUnmount(() => {
  stopBus()
  void stop()
})

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

const find = ref('')
const chanFilter = ref<number>(-1)

const shown = computed(() => {
  const q = find.value.trim().toUpperCase()
  return messages.value.filter((m) => {
    if (chanFilter.value >= 0 && m.freqHz !== chanFilter.value) return false
    if (!q) return true
    return m.registration.toUpperCase().includes(q) || m.flight.toUpperCase().includes(q)
  })
})

const aircraft = computed(() => new Set(messages.value.map((m) => m.registration).filter(Boolean)).size)
const rejected = computed(() => stats.value.reduce((n, s) => n + s.rejected, 0))

const chanOptions = computed(() => [
  { label: 'every channel', value: -1 },
  ...(listening.value?.channels ?? channels.value).map((f) => ({ label: `${mhz(f)} mhz`, value: f })),
])

function describe(m: AcarsMessage): string {
  const bits: string[] = []
  if (m.flight) bits.push(m.flight)
  if (m.msgNo) bits.push(`no ${m.msgNo}`)
  bits.push(`mode ${m.mode}`, `block ${m.blockId}`, m.ack === null ? 'nak' : `ack ${m.ack}`)
  if (!m.end) bits.push('more follows')
  if (m.corrected) bits.push(`${m.corrected} repaired`)
  if (m.labelName) bits.unshift(m.labelName)
  const head = bits.join('  ')
  return m.text ? `${head}  |  ${m.text}` : head
}

const rows = computed(() =>
  shown.value.map((m) => ({
    id: m.id,
    a: m.registration || 'no registration',
    b: `${m.label}  ${formatClock(m.wall)}`,
    c: mhz(m.freqHz),
    decode: describe(m),
    badge: m.downlink ? undefined : 'uplink',
  })),
)

const quiet = computed(() => {
  if (!running.value || messages.value.length) return null
  const s = (now.value - startedAt.value) / 1000
  if (s < QUIET_S) return null
  if (rejected.value > 0) {
    return `${rejected.value} blocks framed but failed the crc. the signal is too weak, or the gain too low or too high.`
  }
  return `nothing decoded yet after ${Math.round(s)} s. acars comes in bursts, a few a minute near an airport and fewer elsewhere. check the antenna.`
})

const status = computed(() => {
  const l = listening.value
  if (!running.value || !l) return null
  const lo = Math.min(...l.channels)
  const hi = Math.max(...l.channels)
  return `${demo.value ? 'demo, ' : ''}${l.channels.length} channels from ${mhz(lo)} to ${mhz(hi)} mhz, window centred on ${mhz(l.center)} mhz at ${msps(l.rate)}`
})
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">messages</div>
        <div class="bn-v">{{ messages.length }}</div>
      </div>
      <div>
        <div class="bn-k">aircraft</div>
        <div class="bn-v">{{ aircraft }}</div>
      </div>
      <div>
        <div class="bn-k">failed crc</div>
        <div class="bn-v is-goo">{{ rejected }}</div>
      </div>
      <div>
        <div class="bn-k">decoder load</div>
        <div class="bn-v">{{ running ? `${loadPct.toFixed(0)}%` : 'idle' }}</div>
      </div>
      <div>
        <div class="bn-k">source</div>
        <div class="bn-v">{{ isSim ? 'demo' : 'iq' }}</div>
      </div>
    </div>

    <div class="bn-acts">
      <HbButton v-if="!running" variant="danger" size="sm" :disabled="!isSim && !!problem" @click="start">
        <template #icon><HbIcon name="play" /></template>
        {{ isSim ? 'run demo traffic' : 'listen' }}
      </HbButton>
      <HbButton v-else size="sm" @click="stop">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="!messages.length" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
    </div>

    <div role="status">
      <p v-if="status" class="bn-note">{{ status }}</p>
      <p v-if="quiet" class="bn-note">{{ quiet }}</p>
    </div>
    <p v-if="problem && !running" class="bn-note" role="alert">{{ problem }}</p>
    <p v-if="error" class="bn-note" role="alert">{{ error }}</p>
    <p v-if="mismatch" class="bn-note" role="alert">{{ mismatch }}</p>
    <p v-if="running && loadPct > 90" class="bn-note" role="alert">
      the decoder is using {{ loadPct.toFixed(0) }}% of real time and will fall behind. turn channels off.
    </p>
    <p v-if="dropped > 0" class="bn-note" role="alert">
      the radio dropped {{ dropped }} samples. blocks that straddle a gap fail the crc.
    </p>

    <div v-if="!isSim" class="bn-knobs">
      <div class="bn-field">
        <label :for="ids.plan">channel plan</label>
        <HbSelect
          :id="ids.plan"
          :model-value="planName"
          :options="PLANS.map((p) => ({ label: p.name, value: p.name }))"
          :disabled="running"
          @update:model-value="setPlan"
        />
      </div>
      <form class="bn-field" @submit.prevent="addChannel">
        <label :for="ids.add">add a channel, mhz</label>
        <div class="ac-add">
          <HbInput :id="ids.add" v-model="typed" inputmode="decimal" autocomplete="off" placeholder="131.725" :disabled="running" />
          <HbButton type="submit" size="sm" :disabled="running || !typed.trim()">
            <template #icon><HbIcon name="plus" /></template>
            add
          </HbButton>
        </div>
      </form>
    </div>
    <p v-if="typedError" class="bn-note" role="alert">{{ typedError }}</p>

    <div v-if="!isSim" class="bn-pills" role="group" aria-label="channels to decode">
      <button
        v-for="f in offered"
        :key="f"
        type="button"
        class="bn-pack"
        :class="{ 'is-on': enabled.includes(f) }"
        :aria-pressed="enabled.includes(f)"
        :disabled="running"
        @click="toggle(f)"
      >
        {{ mhz(f) }}
      </button>
    </div>
    <p v-if="!isSim && !recordingWindow && layout && layout.rate > 2_400_000 && Math.max(...rates) <= 3_200_000 && !running" class="bn-note">
      these channels need {{ msps(layout.rate) }}. if the {{ deviceName }} drops samples at that rate, turn
      off the channel at either end so the rest fit a narrower window.
    </p>

    <div v-if="stats.length" class="bn-list bn-acars-chans" role="table" aria-label="per channel counts">
      <div class="bn-row ac-head" role="row">
        <span class="bn-a" role="columnheader">channel, mhz</span>
        <span class="bn-b" role="columnheader">decoded and failed</span>
        <span class="bn-c" role="columnheader">level</span>
      </div>
      <div v-for="s in stats" :key="s.freqHz" class="bn-row" role="row">
        <span class="bn-a" role="cell">{{ mhz(s.freqHz) }}</span>
        <span class="bn-b" role="cell">{{ s.messages }} {{ s.messages === 1 ? 'msg' : 'msgs' }}  {{ s.rejected }} failed</span>
        <span class="bn-c" role="cell">{{ s.levelDb.toFixed(0) }} db</span>
      </div>
    </div>

    <div class="bn-knobs">
      <div class="bn-field">
        <label :for="ids.find">registration or flight</label>
        <HbInput :id="ids.find" v-model="find" autocomplete="off" placeholder="N824UA or UA2315" />
      </div>
      <div class="bn-field">
        <label :for="ids.chan">channel</label>
        <HbSelect :id="ids.chan" v-model="chanFilter" :options="chanOptions" />
      </div>
    </div>

    <InstPacketList
      :packets="rows"
      :max="MAX"
      :empty-text="
        messages.length ? 'nothing matches that filter.' : 'no messages yet. aircraft send in bursts, so a quiet minute is normal.'
      "
    />

    <div class="bn-hint">
      <HbIcon name="plane" :size="15" />
      <div>
        <b>where to find it</b>
        acars is am on the vhf airband. north america uses 131.550 mhz, with 130.025, 130.450,
        131.125 and 129.125 mhz busy too. europe uses 131.525, 131.725 and 131.825 mhz. one
        window decodes every channel in it at once. an antenna cut for 130 mhz, about 55 cm a
        leg, hears far more than the stock whip.
      </div>
    </div>

    <div v-if="isSim" class="bn-hint">
      <HbIcon name="flask" :size="15" />
      <div>
        <b>demo</b>
        this device is simulated, so the panel keys real acars blocks as msk, puts them on five
        north american channels at 2.88 msps with noise, and runs that through the same
        channeliser and decoder. the texts come from acarsdec's public test recording.
      </div>
    </div>
  </div>
</template>

<style scoped>
.ac-add {
  display: flex;
  gap: var(--hb-s2);
  align-items: center;
}
.bn-list .ac-head > span {
  font-family: var(--hb-utility);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.1em;
  color: var(--hb-ink-3);
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstPacketList from '@/components/instruments/InstPacketList.vue'
import InstKnob from '@/components/instruments/InstKnob.vue'
import { bus } from '@/core/bus/DeviceBus'
import { useDevices } from '@/stores/devices'
import { useReceiver } from '@/composables/useReceiver'
import { useStreamLease } from '@/composables/useStreamLease'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { formatClock, formatHz } from '@/core/format'
import { fixedWindow, nearestReachable, reaches } from '@/core/dsp/spectrumMath'
import {
  SameDecoder,
  describeSame,
  eventName,
  issuedAt,
  locationName,
  originatorName,
} from '@/core/decode/same'
import type { SameHeader } from '@/core/decode/same'
import { ChannelMeter, NOAA_CENTER_HZ, NOAA_CHANNELS, NOAA_RATE } from '@/core/decode/same/channels'
import { sameDemoSource } from '@/core/decode/same/demo'
import type { DemoAudioSource } from '@/core/decode/demo'
import type { Artifact, AudioChunk, IqChunk, ParamSpec } from '@/core/types'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const lease = useStreamLease(props.deviceId)
const rx = useReceiver(props.deviceId, { ownsStream: false })

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const sim = computed(() => isSimKind(node.value?.kind ?? ''))
const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const tuner = computed(() => node.value?.info.tuner ?? node.value?.descriptor.name ?? 'this radio')

/** Seconds of channel levels taken before the strongest is chosen. */
const SCAN_FRAMES = 40
/** A channel this far over the floor carries a transmitter worth decoding. */
const USABLE_DB = 6
const MAX_ROWS = 100
/** Half a channel, kept clear of a recording's filter edge. */
const CHANNEL_EDGE_HZ = 12_500

/** A recording cannot retune, so only the channels inside the window it holds are reachable. */
const recordingWindow = computed(() => {
  const s = centerSpec.value
  return s ? fixedWindow(s, node.value?.params.sampleRate ?? 0, CHANNEL_EDGE_HZ) : null
})

const reachable = computed(() => {
  const w = recordingWindow.value
  if (w) return NOAA_CHANNELS.filter((hz) => hz >= w[0] && hz <= w[1])
  return NOAA_CHANNELS.filter((hz) => !centerSpec.value || reaches(centerSpec.value, hz))
})

/** Frequencies as ui copy, which is lowercase. */
function hz(v: number, decimals = 3): string {
  return formatHz(v, decimals).toLowerCase()
}

/** Whole decibels, without a minus sign on a level that rounds to zero. */
function db(v: number): string {
  return `${Math.round(v) || 0} db`
}

const ranges = computed(() => {
  const s = centerSpec.value
  if (!s) return ''
  const w = recordingWindow.value
  if (w) return `${hz(w[0])} to ${hz(w[1])} in this recording`
  const spans = s.spans ?? [[s.min, s.max]]
  return spans.map(([a, b]) => `${hz(a, 1)} to ${hz(b, 1)}`).join(' and ')
})

interface Row {
  id: string
  at: number
  header: SameHeader | null
  text: string
}

const rows = ref<Row[]>([])
const levels = ref<Array<number | null>>(NOAA_CHANNELS.map(() => null))
/** The channel being decoded, in Hz. */
const channelHz = ref<number | null>(null)
/** Picked by hand. Auto takes the strongest once the levels settle after a start or a retune. */
const manual = ref(false)
const scanning = ref(false)
const running = ref(false)
/** The radio was retuned elsewhere and the window no longer holds the chosen channel. */
const lost = ref(false)
const error = ref<string | null>(null)
const bursts = ref(0)
const demoProgress = ref(0)
const volume = ref(70)
const VOLUME: ParamSpec = { key: 'volume', label: 'volume', min: 0, max: 100, step: 1, default: 70 }

const meter = new ChannelMeter()
const decoder = new SameDecoder()
let meterSkip = 0
let chunkCenter = 0
let chunkRate = 0
let demoTimer = 0
let demo: DemoAudioSource | null = null

const encoder = new TextEncoder()

decoder.onEvent = (e) => {
  if (e.type === 'burst') {
    bursts.value++
    return
  }
  const at = Date.now()
  if (e.type === 'eom') {
    rows.value = [...rows.value, { id: `eom-${at}`, at, header: null, text: 'end of message' }].slice(-MAX_ROWS)
    return
  }
  const h = e.header
  const text = describeSame(h)
  rows.value = [...rows.value, { id: `h-${at}-${h.raw.length}`, at, header: h, text }].slice(-MAX_ROWS)
  bus.emitDecoded(props.deviceId, {
    kind: 'packet',
    proto: 'same',
    bytes: encoder.encode(h.raw),
    summary: text,
    fields: {
      originator: h.originator,
      originatorName: originatorName(h.originator),
      event: h.event,
      eventName: eventName(h.event),
      locations: h.locations,
      locationNames: h.locations.map(locationName),
      purgeMinutes: h.purgeMinutes,
      issuedUtc: issuedAt(h, new Date(at)).toISOString(),
      station: h.station,
      frequencyHz: channelHz.value,
      copies: e.bursts,
    },
  })
}

const stopBus = bus.onDeviceArtifact(props.deviceId, (a: Artifact) => {
  if (!rx.listening.value) return
  if (a.kind === 'audio') {
    const c = a as AudioChunk
    decoder.feed(c.samples, c.sampleRate)
    return
  }
  if (a.kind !== 'iq') return
  const c = a as IqChunk
  if (c.centerHz !== chunkCenter || c.sampleRate !== chunkRate) {
    const retuned = chunkCenter !== 0
    chunkCenter = c.centerHz
    chunkRate = c.sampleRate
    meter.reset()
    levels.value = NOAA_CHANNELS.map(() => null)
    if (retuned) follow(c.centerHz, c.sampleRate)
  }
  // the levels only steer a choice, so one transform in four chunks is plenty.
  if (++meterSkip % 4) return
  meter.push(c.samples, c.sampleRate, c.centerHz)
  if (meter.count % 5 === 0) levels.value = meter.levels(c.sampleRate, c.centerHz)
  if (scanning.value && meter.count >= SCAN_FRAMES) {
    scanning.value = false
    if (!manual.value) pickStrongest()
  }
  // a fresh average every half minute follows a transmitter that fades.
  if (meter.count >= SCAN_FRAMES * 8) meter.reset()
})

const strongest = computed(() => {
  let best = -1
  levels.value.forEach((v, i) => {
    if (v !== null && (best < 0 || v > (levels.value[best] ?? -Infinity))) best = i
  })
  return best
})

const chosenLevel = computed(() => {
  const i = channelHz.value === null ? -1 : NOAA_CHANNELS.indexOf(channelHz.value)
  return i >= 0 ? levels.value[i] : null
})

function pickStrongest(): void {
  const i = strongest.value
  if (i < 0) return
  listenOn(NOAA_CHANNELS[i])
}

function listenOn(hz: number): void {
  channelHz.value = hz
  const center = chunkCenter || node.value?.params.centerHz || NOAA_CENTER_HZ
  rx.setOffset(hz - center)
}

/** Another panel moved the radio. The chosen channel is followed inside the new window, or named lost. */
function follow(centerHz: number, rate: number): void {
  const inside = (f: number) => Math.abs(f - centerHz) + CHANNEL_EDGE_HZ <= rate / 2
  if (!manual.value) {
    scanning.value = true
    lost.value = !NOAA_CHANNELS.some(inside)
    return
  }
  if (channelHz.value === null) return
  lost.value = !inside(channelHz.value)
  if (!lost.value) rx.setOffset(channelHz.value - centerHz)
}

function choose(hz: number | null): void {
  manual.value = hz !== null
  if (hz === null) {
    if (running.value && !sim.value) pickStrongest()
    else channelHz.value = null
    return
  }
  if (sim.value) {
    channelHz.value = hz
    return
  }
  listenOn(hz)
}

function rateFor(): number {
  const s = node.value?.descriptor.params.find((p) => p.key === 'sampleRate')
  if (!s?.choices?.length) return NOAA_RATE
  // the channels span 150 kHz around a centre 250 kHz below them.
  const ok = s.choices.filter((r) => r >= 800_000)
  return ok.length ? ok.reduce((a, b) => (Math.abs(a - NOAA_RATE) <= Math.abs(b - NOAA_RATE) ? a : b)) : s.max
}

async function start(): Promise<void> {
  error.value = null
  if (sim.value) {
    startDemo()
    return
  }
  if (!reachable.value.length) {
    error.value = recordingWindow.value
      ? `this recording covers ${ranges.value.replace(' in this recording', '')}, with no noaa channel inside.`
      : `no tuner here reaches 162.400 to 162.550 mhz. the ${tuner.value} covers ${ranges.value}.`
    return
  }
  const spec = centerSpec.value
  const recorded = recordingWindow.value && spec ? spec.min : null
  const center = recorded ?? (spec ? nearestReachable(spec, NOAA_CENTER_HZ) : NOAA_CENTER_HZ)
  const gain = node.value?.descriptor.params.find((p) => p.key === 'gain')
  const params: Record<string, number> = recorded === null ? { centerHz: center, sampleRate: rateFor() } : {}
  if (gain) params.gain = gain.default
  if (manual.value && channelHz.value !== null && !reachable.value.includes(channelHz.value)) {
    manual.value = false
    channelHz.value = null
  }
  const t = lease.begin()
  try {
    if (Object.keys(params).length) await devices.configure(props.deviceId, params)
    if (!lease.current(t)) return
    if (node.value?.error) throw new Error(node.value.error)
    rx.setMode('nfm')
    chunkCenter = 0
    lost.value = false
    meter.reset()
    levels.value = NOAA_CHANNELS.map(() => null)
    if (manual.value && channelHz.value !== null) rx.setOffset(channelHz.value - center)
    scanning.value = true
    await rx.start()
    if (!lease.current(t)) {
      await rx.stop()
      return
    }
    if (!(await lease.stream(t))) {
      await rx.stop()
      return
    }
    rx.setVolume(volume.value / 100)
    running.value = true
  } catch (err) {
    if (!lease.current(t)) return
    error.value = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
    await stop()
  }
}

async function stop(): Promise<void> {
  stopDemo()
  scanning.value = false
  running.value = false
  lost.value = false
  decoder.reset()
  await rx.stop()
  await lease.release()
}

function startDemo(): void {
  stopDemo()
  decoder.reset()
  demo = sameDemoSource()
  channelHz.value = channelHz.value ?? 162_550_000
  running.value = true
  let last = performance.now()
  demoTimer = window.setInterval(() => {
    const src = demo
    if (!src) return
    const now = performance.now()
    // sized from the clock, so a throttled background tab keeps real time.
    const block = src.read(Math.min(3000, now - last))
    last = now
    if (block.length) decoder.feed(block, src.sampleRate)
    demoProgress.value = src.progress
    if (src.done) stopDemo()
  }, 25)
}

function stopDemo(): void {
  if (demoTimer) window.clearInterval(demoTimer)
  demoTimer = 0
  demo = null
  if (sim.value) running.value = false
}

function setVolume(v: number): void {
  volume.value = v
  rx.setVolume(v / 100)
}

function clear(): void {
  rows.value = []
  bursts.value = 0
}

const status = computed(() => {
  if (error.value) return error.value
  if (!running.value) {
    return sim.value
      ? 'demo device. start plays a synthetic weekly test through the real decoder.'
      : recordingWindow.value
        ? 'idle. start plays the recording and listens to the noaa channels inside it.'
        : 'idle. start tunes the radio to the noaa channels and listens.'
  }
  if (sim.value) return 'playing a synthetic weekly test through the decoder'
  if (lost.value) {
    const what = manual.value ? 'the chosen channel is outside its window' : 'no noaa channel is inside its window'
    return `another panel retuned the radio to ${hz(chunkCenter)}, and ${what}. press stop, then start.`
  }
  if (scanning.value) return `measuring the ${reachable.value.length === 1 ? 'one channel' : `${reachable.value.length} channels`} in reach`
  if (channelHz.value === null) return 'no channel chosen'
  const lvl = chosenLevel.value
  const how = manual.value ? 'picked by hand' : 'the strongest in range'
  if (lvl !== null && lvl < USABLE_DB) {
    return `signal too weak on ${hz(channelHz.value)}, ${db(lvl)} over the floor. try an outdoor antenna or another channel.`
  }
  return `listening to ${hz(channelHz.value)}, ${how}`
})

const tableRows = computed(() =>
  [...rows.value].reverse().map((r) => ({
    id: r.id,
    a: r.header ? r.header.event : 'NNNN',
    b: r.header
      ? `${formatClock(r.at)}  ${r.header.locations.length} area${r.header.locations.length === 1 ? '' : 's'}`
      : formatClock(r.at),
    c: '',
    decode: r.header ? `${r.text}. ${r.header.raw}` : r.text,
    badge: r.header && r.header.event !== 'RWT' && r.header.event !== 'RMT' ? 'alert' : undefined,
  })),
)

const headerCount = computed(() => rows.value.filter((r) => r.header).length)

function barWidth(v: number | null): string {
  if (v === null) return '0%'
  return `${Math.max(0, Math.min(100, (v / 30) * 100)).toFixed(0)}%`
}

onBeforeUnmount(() => {
  stopBus()
  stopDemo()
  void rx.stop()
  void lease.release()
})
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">headers</div>
        <div class="bn-v">{{ headerCount }}</div>
      </div>
      <div>
        <div class="bn-k">bursts heard</div>
        <div class="bn-v">{{ bursts }}</div>
      </div>
      <div>
        <div class="bn-k">channel</div>
        <div class="bn-v">{{ channelHz ? hz(channelHz) : 'auto' }}</div>
      </div>
      <div v-if="chosenLevel !== null && !sim">
        <div class="bn-k">level</div>
        <div class="bn-v">{{ db(chosenLevel) }}</div>
      </div>
      <div>
        <div class="bn-k">source</div>
        <div class="bn-v">{{ sim ? 'demo' : 'nfm audio' }}</div>
      </div>
    </div>

    <div class="bn-acts">
      <HbButton v-if="!running" variant="danger" size="sm" @click="start">
        <template #icon><HbIcon name="play" /></template>
        {{ sim ? 'run demo alert' : 'start' }}
      </HbButton>
      <HbButton v-else size="sm" @click="stop">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="!rows.length" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
    </div>

    <p class="bn-note" role="status" aria-live="polite">{{ status }}</p>

    <div v-if="sim && demoProgress > 0 && demoProgress < 1" class="bn-prog">
      <i :style="{ width: `${Math.round(demoProgress * 100)}%` }" />
    </div>

    <div class="bn-chans" role="group" aria-label="noaa weather radio channel">
      <button
        type="button"
        class="bn-chan"
        :class="{ 'is-on': !manual }"
        :aria-pressed="!manual"
        @click="choose(null)"
      >
        <b>auto</b>
        strongest
      </button>
      <button
        v-for="(hz, i) in NOAA_CHANNELS"
        :key="hz"
        type="button"
        class="bn-chan"
        :class="{ 'is-on': manual && channelHz === hz }"
        :aria-pressed="manual && channelHz === hz"
        :disabled="!reachable.includes(hz)"
        :aria-label="`${(hz / 1e6).toFixed(3)} megahertz${levels[i] !== null ? `, ${db(levels[i]!)} over the floor` : ''}`"
        @click="choose(hz)"
      >
        <b>{{ (hz / 1e6).toFixed(3) }}</b>
        {{ levels[i] !== null ? db(levels[i]!) : reachable.includes(hz) ? 'not measured' : 'out of range' }}
        <span class="bn-chan-bar" aria-hidden="true"><i :style="{ width: barWidth(levels[i]) }" /></span>
      </button>
    </div>

    <div class="bn-knobs">
      <InstKnob :model-value="volume" :spec="VOLUME" @update:model-value="setVolume" />
    </div>

    <InstPacketList
      :packets="tableRows"
      :max="MAX_ROWS"
      empty-text="nothing decoded yet. headers come only with an alert or a test, so a quiet channel is normal."
    />

    <div class="bn-hint">
      <HbIcon name="warning" :size="15" />
      <div>
        <b>what this hears</b>
        noaa weather radio sends a same header before every alert: three bursts of 520 baud
        tones naming the event, the counties, how long it lasts and the station. most
        transmitters run the required weekly test on wednesday between 11 am and noon local, so
        that is the reliable time to see one. the voice in between is the forecast loop and
        carries no data.
      </div>
    </div>
  </div>
</template>

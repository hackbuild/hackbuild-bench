<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { HbButton, HbIcon, HbInput, HbSelect } from '@virgilvox/hackbuild-ui'
import InstPacketList from '@/components/instruments/InstPacketList.vue'
import { bus } from '@/core/bus/DeviceBus'
import { useDevices } from '@/stores/devices'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { formatClock, formatHz, formatRate } from '@/core/format'
import { fixedWindow, nearestReachable, parseFrequency, reaches, spansOf } from '@/core/dsp/spectrumMath'
import { PagerDecoder } from '@/core/decode/pager'
import type { PagerMessage } from '@/core/decode/pager'
import { DEMO_OFFSET_HZ, PagerDemoSource } from '@/core/decode/pager/demo'
import type { Artifact, IqChunk } from '@/core/types'
import type { DeviceToolProps } from '@/tools/types'
import { useStreamLease } from '@/composables/useStreamLease'

const props = defineProps<DeviceToolProps>()
const devices = useDevices()
const lease = useStreamLease(props.deviceId)

const MAX = 300
/** The radio is tuned this far from the channel, so the channel stays off the dc spike. */
const TUNE_AWAY_HZ = 250000
const WANT_RATE = 1024000
/** Half the channel the decoder cuts, plus margin. The channel has to sit this far inside the window. */
const CHANNEL_EDGE_HZ = 20000
const DEMO_SPEED = 4
const TICK_MS = 25
const LEVEL_MS = 500
/** How long the channel is watched before it is called idle or too weak. */
const SETTLE_MS = 8000

/**
 * A few channels to start from. Paging in the US sits on 152 to 159 MHz,
 * where POCSAG is common, and on 929 to 932 MHz in 25 kHz steps, mostly FLEX.
 */
const PRESETS = [
  { label: '152.0075 mhz, vhf, hospital paging', value: '152.0075' },
  { label: '152.2400 mhz, vhf paging', value: '152.24' },
  { label: '152.4800 mhz, vhf paging', value: '152.48' },
  { label: '157.7400 mhz, vhf paging', value: '157.74' },
  { label: '158.1000 mhz, vhf paging', value: '158.1' },
  { label: '158.7000 mhz, vhf paging', value: '158.7' },
  { label: '929.6000 mhz, flex 6400/4 heard on this bench', value: '929.6' },
  { label: '931.0000 mhz, 931 paging block', value: '931' },
]

const ids = { freq: useId(), preset: useId(), gain: useId(), filter: useId(), note: useId() }

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isSim = computed(() => (node.value ? isSimKind(node.value.kind) : false))
const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const rateSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'sampleRate'))
const gainSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'gain'))
const tunerName = computed(() => node.value?.info.tuner ?? node.value?.label ?? 'radio')

const freqText = ref('152.0075')
const preset = ref<string | number>('')
const gain = ref<number>(node.value?.params.gain ?? gainSpec.value?.default ?? 0)
const filter = ref('')

const messages = ref<PagerMessage[]>([])
const live = ref(false)
const demoRunning = ref(false)
const demoProgress = ref(0)
const error = ref<string | null>(null)
const offWindow = ref(false)
const listeningHz = ref(0)
const rateInUse = ref(0)
const channelDb = ref(-120)
const floorDb = ref(Infinity)
const offsetHz = ref(0)
const deviationHz = ref(0)
const synced = ref(false)
const frames = ref(0)
const listenedMs = ref(0)
let listenStart = 0

const running = computed(() => live.value || demoRunning.value)
const freqHz = computed(() => parseFrequency(freqText.value))

const gainOptions = computed(() => {
  const s = gainSpec.value
  if (!s) return []
  const out: Array<{ label: string; value: number }> = []
  const step = Math.max(1, Math.round((s.max - s.min) / 10))
  for (let v = s.min; v < s.max; v += step) out.push({ label: `${v} db`, value: v })
  out.push({ label: s.topLabel ? `${s.topLabel}` : `${s.max} db`, value: s.max })
  return out
})

const rangeText = computed(() => {
  const s = centerSpec.value
  if (!s) return ''
  return spansOf(s)
    .map(([lo, hi]) => `${(lo / 1e6).toFixed(1)} to ${(hi / 1e6).toFixed(1)} mhz`)
    .join(' and ')
})

/** A recording cannot retune, so the channel has to sit inside the window it holds. */
const recordingWindow = computed(() => {
  const s = centerSpec.value
  return s ? fixedWindow(s, node.value?.params.sampleRate ?? 0, CHANNEL_EDGE_HZ) : null
})

/** Refusal shown before start, so the button is never pressed for nothing. */
const tuneProblem = computed(() => {
  if (isSim.value) return null
  const hz = freqHz.value
  if (hz === null) return 'that is not a frequency. try 152.0075 or 929.6 mhz.'
  const w = recordingWindow.value
  if (w) {
    if (hz < w[0] || hz > w[1]) {
      return `this recording holds ${(w[0] / 1e6).toFixed(4)} to ${(w[1] / 1e6).toFixed(4)} mhz. pick a frequency inside it.`
    }
    return null
  }
  const s = centerSpec.value
  if (s && !reaches(s, hz)) {
    return `no tuner reaches ${(hz / 1e6).toFixed(4)} mhz. the ${tunerName.value} covers ${rangeText.value}.`
  }
  return null
})

// a recording opens on its own centre, the one frequency certain to be in it.
watch(
  recordingWindow,
  (w) => {
    if (w) freqText.value = ((w[0] + w[1]) / 2 / 1e6).toFixed(4)
  },
  { immediate: true },
)

const decoder = new PagerDecoder()
decoder.onMessage = (m) => {
  messages.value = [m, ...messages.value].slice(0, MAX)
  // demo pages stay in the panel, so the session log and automations see only real air.
  if (!demoRunning.value) publish(m)
}

function funcLabel(m: PagerMessage): string {
  if (m.proto === 'pocsag') return `function ${m.func}`
  return m.kind === 'tone' ? 'tone' : m.kind
}

function rateLabel(m: PagerMessage): string {
  return m.proto === 'flex' ? `flex ${m.baud}/${m.levels}` : `pocsag ${m.baud}`
}

function publish(m: PagerMessage): void {
  const text = m.text || (m.kind === 'tone' ? 'tone only' : '')
  const summary = `${rateLabel(m)} ${m.address}${m.group?.length ? ` +${m.group.length}` : ''}: ${text}`
  bus.emitDecoded(props.deviceId, {
    kind: 'packet',
    proto: m.proto,
    bytes: new TextEncoder().encode(m.text),
    summary,
    fields: {
      address: m.address,
      baud: m.baud,
      levels: m.levels,
      function: m.func,
      kind: m.kind,
      text: m.text,
      ...(m.group ? { group: m.group } : {}),
      ...(m.phase ? { phase: m.phase, cycle: m.cycle, frame: m.frame } : {}),
      ...(m.alt ? { other: m.alt } : {}),
      partial: Boolean(m.partial),
      corrected: m.corrected,
      frequencyHz: listeningHz.value,
    },
  })
}

const shown = computed(() => {
  const f = filter.value.trim()
  if (!f) return messages.value
  return messages.value.filter(
    (m) => String(m.address).includes(f) || (m.group ?? []).some((g) => String(g).includes(f)),
  )
})

const rows = computed(() =>
  shown.value.map((m) => ({
    id: m.id,
    a: String(m.address),
    b: `${rateLabel(m)}  ${funcLabel(m)}  ${formatClock(m.at)}`,
    c: m.group?.length ? `group of ${m.group.length}` : '',
    decode: [
      m.text || (m.kind === 'tone' ? 'tone only, no message' : 'empty'),
      m.group?.length ? `  to ${m.group.join(' ')}` : '',
    ].join(''),
    badge: m.partial ? 'damaged' : undefined,
  })),
)

const addresses = computed(() => new Set(messages.value.map((m) => m.address)).size)

/** What the panel says it is doing, and the first thing that is wrong. */
const status = computed(() => {
  if (demoRunning.value) return 'demo: a synthetic channel with pocsag at three rates and flex in two modes.'
  if (!live.value) return null
  if (offWindow.value) {
    return `the radio moved off ${formatHz(listeningHz.value, 4).toLowerCase()}. another tool retuned it, so press stop and start again.`
  }
  const over = channelDb.value - floorDb.value
  if (!messages.value.length) {
    if (synced.value) return 'a pager signal has sync but no page has decoded yet.'
    if (listenedMs.value > SETTLE_MS && Number.isFinite(over) && over < 3) {
      return 'nothing decoded yet. the channel reads at its own noise floor, so it is idle or the signal is too weak for this antenna.'
    }
    return 'nothing decoded yet. paging is bursty, and pocsag in particular can be quiet for minutes.'
  }
  return null
})

let unsubscribe: (() => void) | null = null
let levelTimer = 0
let demoTimer = 0

function readLevels(): void {
  const l = decoder.levels()
  channelDb.value = l.channelDb
  if (live.value && l.channelDb > -119) floorDb.value = Math.min(floorDb.value, l.channelDb)
  offsetHz.value = l.offsetHz
  deviationHz.value = l.deviationHz
  synced.value = decoder.busy
  frames.value = decoder.flexFrames
  if (live.value) listenedMs.value = performance.now() - listenStart
}

function onIq(a: Artifact): void {
  if (a.kind !== 'iq' || !live.value) return
  const c = a as IqChunk
  const offset = listeningHz.value - c.centerHz
  rateInUse.value = c.sampleRate
  if (Math.abs(offset) > c.sampleRate / 2 - CHANNEL_EDGE_HZ) {
    offWindow.value = true
    return
  }
  offWindow.value = false
  decoder.feedIq(c.samples, c.sampleRate, offset)
}

function pickRate(): number {
  const s = rateSpec.value
  if (!s) return WANT_RATE
  if (s.choices?.length) {
    if (s.choices.includes(WANT_RATE)) return WANT_RATE
    const above = s.choices.filter((r) => r >= WANT_RATE).sort((x, y) => x - y)
    return above[0] ?? s.choices[s.choices.length - 1]
  }
  return Math.min(s.max, Math.max(s.min, WANT_RATE))
}

/** A centre that keeps the channel off the dc spike when the tuner allows it. */
function pickCenter(hz: number): number {
  const s = centerSpec.value
  if (s && recordingWindow.value) return s.min
  if (!s) return hz + TUNE_AWAY_HZ
  for (const c of [hz + TUNE_AWAY_HZ, hz - TUNE_AWAY_HZ]) if (reaches(s, c)) return c
  return nearestReachable(s, hz)
}

async function start(): Promise<void> {
  error.value = null
  if (isSim.value) {
    startDemo()
    return
  }
  const hz = freqHz.value
  if (hz === null || tuneProblem.value) {
    error.value = tuneProblem.value
    return
  }
  const n = node.value
  if (!n) return
  const t = lease.begin()
  const center = pickCenter(hz)
  const rate = pickRate()
  const params: Record<string, number> = { centerHz: center, sampleRate: rate }
  if (gainSpec.value) params.gain = gain.value
  try {
    await devices.configure(props.deviceId, params)
  } catch (err) {
    if (!lease.current(t)) return
    error.value = err instanceof Error ? err.message : String(err)
    void lease.release()
    return
  }
  if (!lease.current(t)) return
  const now = node.value
  if (!now || now.params.centerHz !== center) {
    error.value = now?.error ?? `the ${tunerName.value} would not tune to ${formatHz(center, 4).toLowerCase()}.`
    void lease.release()
    return
  }
  decoder.reset()
  listeningHz.value = hz
  floorDb.value = Infinity
  listenStart = performance.now()
  listenedMs.value = 0
  offWindow.value = false
  live.value = true
  try {
    if (!(await lease.stream(t))) return
  } catch (err) {
    if (!lease.current(t)) return
    live.value = false
    error.value = err instanceof Error ? err.message : String(err)
    void lease.release()
    return
  }
  clearInterval(levelTimer)
  levelTimer = window.setInterval(readLevels, LEVEL_MS)
}

async function stop(): Promise<void> {
  stopDemo()
  clearInterval(levelTimer)
  levelTimer = 0
  if (live.value) decoder.flush()
  live.value = false
  await lease.release()
}

function startDemo(): void {
  stopDemo()
  decoder.reset()
  const src = new PagerDemoSource()
  listeningHz.value = 0
  demoRunning.value = true
  demoProgress.value = 0
  let last = performance.now()
  demoTimer = window.setInterval(() => {
    const now = performance.now()
    // sized from the clock, so a throttled background tab keeps the same pace.
    const ms = Math.min(1000, (now - last) * DEMO_SPEED)
    last = now
    const block = src.read(ms)
    if (block.length) decoder.feedIq(block, src.sampleRate, DEMO_OFFSET_HZ)
    demoProgress.value = src.progress
    readLevels()
    if (src.done) {
      decoder.flush()
      stopDemo()
    }
  }, TICK_MS)
}

function stopDemo(): void {
  if (demoTimer) clearInterval(demoTimer)
  demoTimer = 0
  demoRunning.value = false
}

function applyPreset(v: string | number): void {
  preset.value = v
  if (v !== '') freqText.value = String(v)
}

function clear(): void {
  messages.value = []
}

unsubscribe = bus.onDeviceArtifact(props.deviceId, onIq)

onBeforeUnmount(() => {
  unsubscribe?.()
  clearInterval(levelTimer)
  stopDemo()
  void stop()
})
</script>

<template>
  <div>
    <p :id="ids.note" class="bn-note pg-lead">
      pages carry personal details. listen only where that is lawful.
    </p>

    <div class="bn-meta">
      <div>
        <div class="bn-k">pages</div>
        <div class="bn-v">{{ messages.length }}</div>
      </div>
      <div>
        <div class="bn-k">addresses</div>
        <div class="bn-v">{{ addresses }}</div>
      </div>
      <div>
        <div class="bn-k">flex frames</div>
        <div class="bn-v">{{ frames }}</div>
      </div>
      <div>
        <div class="bn-k">channel</div>
        <div class="bn-v">
          {{ running && Number.isFinite(floorDb) ? `+${Math.max(0, channelDb - floorDb).toFixed(0)} db` : running ? `${channelDb.toFixed(0)} db` : 'off' }}
        </div>
      </div>
      <div>
        <div class="bn-k">carrier offset</div>
        <div class="bn-v">{{ running ? `${(offsetHz / 1000).toFixed(1)} khz` : 'off' }}</div>
      </div>
      <div>
        <div class="bn-k">deviation</div>
        <div class="bn-v">{{ running ? `${(deviationHz / 1000).toFixed(1)} khz` : 'off' }}</div>
      </div>
    </div>

    <div class="bn-knobs">
      <div class="bn-field">
        <label :for="ids.freq">frequency, mhz</label>
        <HbInput
          :id="ids.freq"
          v-model="freqText"
          :invalid="Boolean(tuneProblem)"
          inputmode="decimal"
          autocomplete="off"
          :disabled="running || isSim"
          placeholder="152.0075"
        />
      </div>
      <div class="bn-field">
        <label :for="ids.preset">presets</label>
        <HbSelect
          :id="ids.preset"
          :model-value="preset"
          :options="[{ label: 'pick a channel', value: '' }, ...PRESETS]"
          :disabled="running || isSim"
          @update:model-value="applyPreset"
        />
      </div>
      <div v-if="gainOptions.length" class="bn-field">
        <label :for="ids.gain">gain</label>
        <HbSelect
          :id="ids.gain"
          :model-value="gain"
          :options="gainOptions"
          :disabled="running || isSim"
          @update:model-value="(v: string | number) => (gain = Number(v))"
        />
      </div>
    </div>

    <div class="bn-acts">
      <HbButton v-if="!running" variant="danger" size="sm" :disabled="Boolean(tuneProblem)" @click="start">
        <template #icon><HbIcon name="play" /></template>
        {{ isSim ? 'run demo pages' : 'listen' }}
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

    <p v-if="tuneProblem && !isSim" class="bn-note" role="alert">{{ tuneProblem }}</p>
    <p v-if="error" class="bn-note" role="alert">{{ error }}</p>
    <div aria-live="polite">
      <p v-if="live" class="bn-note">
        listening to {{ formatHz(listeningHz, 4).toLowerCase() }} for pocsag at 512, 1200 and 2400 baud and flex in
        every mode, from iq at {{ formatRate(rateInUse || pickRate()).toLowerCase() }}.
      </p>
      <p v-if="status" class="bn-note">{{ status }}</p>
    </div>

    <div
      v-if="demoRunning"
      class="bn-prog"
      role="progressbar"
      aria-label="demo progress"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.round(demoProgress * 100)"
    >
      <i :style="{ width: `${Math.round(demoProgress * 100)}%` }" />
    </div>

    <div class="bn-knobs">
      <div class="bn-field">
        <label :for="ids.filter">filter by address</label>
        <HbInput :id="ids.filter" v-model="filter" inputmode="numeric" autocomplete="off" placeholder="capcode or address" />
      </div>
    </div>

    <InstPacketList
      :packets="rows"
      :max="MAX"
      :empty-text="filter ? 'no page from that address yet.' : 'no pages yet.'"
    />

    <div class="bn-hint">
      <HbIcon name="bell" :size="15" />
      <div>
        <b>where to find it</b>
        in the us, pocsag sits around 152 to 159 mhz and flex on 929 to 932 mhz in 25 khz steps. the
        decoder tries every pocsag rate and both polarities, and reads the flex mode from each frame's
        sync, so the frequency is the only thing to set. at 930 mhz a crystal 20 ppm out puts the carrier
        19 khz away, past the channel filter, so set the radio's ppm first. the carrier offset readout
        shows what is left.
      </div>
    </div>

    <div v-if="isSim" class="bn-hint">
      <HbIcon name="flask" :size="15" />
      <div>
        <b>demo</b>
        this device is simulated, so the panel builds real pocsag batches and flex frames, frequency
        modulates them onto a noisy carrier and runs the iq through the same decoder. it plays at four
        times real time.
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg-lead {
  margin: 0 0 var(--hb-s3);
}
</style>

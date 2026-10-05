<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
import { HbButton, HbIcon, HbInput } from '@virgilvox/hackbuild-ui'
import InstKnob from '@/components/instruments/InstKnob.vue'
import { bus } from '@/core/bus/DeviceBus'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { fixedWindow, parseFrequency, reaches } from '@/core/dsp/spectrumMath'
import { FRAME_H, FRAME_W } from '@/core/decode/ntsc'
import type { NtscStatus } from '@/core/decode/ntsc'
import type { NtscWorkerIn, NtscWorkerOut } from '@/core/decode/ntsc/ntsc.worker'
import { DEMO_ATV_HZ, NtscDemoSource } from '@/core/decode/ntsc/demo'
import { useDevices } from '@/stores/devices'
import { useStreamLease } from '@/composables/useStreamLease'
import { useReceiver } from '@/composables/useReceiver'
import type { Artifact, IqChunk, ParamSpec } from '@/core/types'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()
const devices = useDevices()
const lease = useStreamLease(props.deviceId)
const rx = useReceiver(props.deviceId, { ownsStream: false })
const uid = useId()

/** Analog tv carriers in use near Phoenix, and the usual amateur ones. */
const PRESETS: Array<{ hz: number; label: string }> = [
  { hz: 421_250_000, label: 'w7atn mesa' },
  { hz: 1_253_250_000, label: 'w7atn white tank' },
  { hz: 427_250_000, label: '427.25' },
  { hz: 434_000_000, label: '434.00' },
  { hz: 439_250_000, label: '439.25' },
]
const SOUND_ABOVE_HZ = 4_500_000
const WANT_RATE = 2_400_000
const BACKLOG_S = 2

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isSim = computed(() => (node.value ? isSimKind(node.value.kind) : false))
const tuner = computed(() => node.value?.info.tuner ?? '')
const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const rateSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'sampleRate'))
const gainSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'gain'))
const recording = computed(() => {
  const s = centerSpec.value
  const r = node.value?.params.sampleRate ?? 0
  return s && fixedWindow(s, r) ? { centerHz: s.min, rate: r } : null
})

const carrierHz = ref(PRESETS[0].hz)
const typed = ref((PRESETS[0].hz / 1e6).toFixed(2))
const typedBad = ref(false)
const running = ref(false)
const demo = ref(false)
const stage = ref<'picture' | 'sound'>('picture')
const error = ref<string | null>(null)
const status = shallowRef<NtscStatus | null>(null)
const fps = ref(0)
const brightness = ref(0)
const contrast = ref(100)
const BRIGHT: ParamSpec = {
  key: 'brightness',
  label: 'brightness',
  min: -50,
  max: 50,
  step: 1,
  default: 0,
}
const CONTRAST: ParamSpec = {
  key: 'contrast',
  label: 'contrast',
  min: 25,
  max: 400,
  step: 5,
  default: 100,
}

const reachable = computed(() => {
  if (isSim.value) return true
  const r = recording.value
  if (r) return true
  const s = centerSpec.value
  return !s || reaches(s, carrierHz.value)
})

function scanRate(): number {
  const s = rateSpec.value
  if (!s?.choices?.length) return s ? Math.min(s.max, Math.max(s.min, WANT_RATE)) : WANT_RATE
  const under = s.choices.filter((r) => r <= WANT_RATE)
  return under.length ? Math.max(...under) : Math.min(...s.choices)
}

const canvas = ref<HTMLCanvasElement | null>(null)
let image: ImageData | null = null
let frameTimes: number[] = []

function paint(pixels: Uint8ClampedArray): void {
  const c = canvas.value
  if (!c) return
  const ctx = c.getContext('2d')
  if (!ctx) return
  if (!image) image = ctx.createImageData(FRAME_W, FRAME_H)
  const d = image.data
  for (let i = 0, j = 0; i < pixels.length; i++, j += 4) {
    const v = pixels[i]
    d[j] = v
    d[j + 1] = v
    d[j + 2] = v
    d[j + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  const now = performance.now()
  frameTimes.push(now)
  while (frameTimes.length && now - frameTimes[0] > 1000) frameTimes.shift()
  fps.value = frameTimes.length
}

// ---------------------------------------------------------------------------
// the decoder, in a worker
// ---------------------------------------------------------------------------

let worker: Worker | null = null
let gen = 0
let posted = 0
let consumed = 0
let want = { centerHz: 0, rate: 0 }

function ensureWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('../../core/decode/ntsc/ntsc.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<NtscWorkerOut>) => {
    const m = e.data
    if (m.type === 'status') consumed = m.consumed
    if (m.gen !== gen) return
    if (m.type === 'status') status.value = m.status
    else paint(m.pixels)
  }
  worker.onerror = (e) => {
    error.value = `the decoder stopped: ${String(e.message ?? 'unknown error').toLowerCase()}`
    worker?.terminate()
    worker = null
    posted = 0
    consumed = 0
  }
  sendLevels()
  return worker
}

function sendLevels(): void {
  const msg: NtscWorkerIn = {
    type: 'levels',
    levels: {
      brightness: brightness.value / 100,
      contrast: contrast.value / 100,
    },
  }
  worker?.postMessage(msg)
}
watch([brightness, contrast], sendLevels)

/** A fresh decoder for a window, with the carrier this far from its centre. */
function startDecoder(rate: number, offsetHz: number, searchHz: number): void {
  gen++
  status.value = null
  frameTimes = []
  fps.value = 0
  const msg: NtscWorkerIn = {
    type: 'start',
    gen,
    rate,
    carrierOffsetHz: offsetHz,
    searchHz,
  }
  ensureWorker().postMessage(msg)
}

function feed(samples: Float32Array, centerHz: number, rate: number): void {
  if (stage.value !== 'picture' || !worker) return
  if (Math.abs(centerHz - want.centerHz) > 5_000 || Math.abs(rate - want.rate) > rate * 0.01) return
  if (posted - consumed > rate * BACKLOG_S) return
  posted += samples.length / 2
  const copy = samples.slice()
  const msg: NtscWorkerIn = { type: 'iq', gen, samples: copy }
  worker.postMessage(msg, [copy.buffer])
}

const stopBus = bus.onDeviceArtifact(props.deviceId, (a: Artifact) => {
  if (a.kind !== 'iq' || !running.value || demo.value) return
  const c = a as IqChunk
  feed(c.samples, c.centerHz, c.sampleRate)
})

// ---------------------------------------------------------------------------
// tuning
// ---------------------------------------------------------------------------

let demoSource: NtscDemoSource | null = null
let demoTimer = 0
let demoLast = 0

/** Puts the carrier a quarter of the window below centre, clear of a zero if tuner's dc spike. */
async function tunePicture(): Promise<void> {
  stage.value = 'picture'
  const r = recording.value
  if (r && !demo.value) {
    want = { centerHz: r.centerHz, rate: r.rate }
    const inside = Math.abs(carrierHz.value - r.centerHz) < r.rate * 0.45
    startDecoder(r.rate, inside ? carrierHz.value - r.centerHz : 0, inside ? 80_000 : r.rate * 0.45)
    return
  }
  const rate = demo.value ? WANT_RATE : scanRate()
  const offset = -Math.round(rate / 4)
  want = { centerHz: carrierHz.value - offset, rate }
  startDecoder(rate, offset, 80_000)
  if (demo.value) return
  await devices.configure(props.deviceId, {
    centerHz: want.centerHz,
    sampleRate: rate,
  })
}

/** The sound is 4.5 MHz up, out of the picture's window, so the radio moves to it. */
async function tuneSound(): Promise<void> {
  if (recording.value || demo.value) return
  stage.value = 'sound'
  gen++
  const rate = scanRate()
  const offset = -Math.round(rate / 4)
  want = { centerHz: carrierHz.value + SOUND_ABOVE_HZ - offset, rate }
  await devices.configure(props.deviceId, {
    centerHz: want.centerHz,
    sampleRate: rate,
  })
  rx.setMode('fm')
  rx.setOffset(offset)
  await rx.start()
}

async function showPicture(): Promise<void> {
  await rx.stop()
  await tunePicture()
}

async function start(): Promise<void> {
  error.value = null
  if (isSim.value) {
    demo.value = true
    running.value = true
    demoSource = new NtscDemoSource(DEMO_ATV_HZ)
    carrierHz.value = DEMO_ATV_HZ
    typed.value = (DEMO_ATV_HZ / 1e6).toFixed(2)
    await tunePicture()
    demoLast = performance.now()
    // blocks are sized from the clock, so a throttled background tab keeps time.
    demoTimer = window.setInterval(() => {
      const src = demoSource
      if (!src) return
      const now = performance.now()
      const ms = Math.min(100, now - demoLast)
      demoLast = now
      if (ms <= 0) return
      const iq = src.read(ms, want.centerHz, want.rate)
      if (worker) {
        const msg: NtscWorkerIn = { type: 'iq', gen, samples: iq }
        worker.postMessage(msg, [iq.buffer])
      }
    }, 30)
    return
  }
  if (!reachable.value) return
  const t = lease.begin()
  try {
    running.value = true
    await tunePicture()
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
  running.value = false
  stage.value = 'picture'
  gen++
  want = { centerHz: 0, rate: 0 }
  await rx.stop()
  await lease.release()
}

async function choose(hz: number): Promise<void> {
  carrierHz.value = hz
  typed.value = (hz / 1e6).toFixed(2)
  typedBad.value = false
  if (running.value && !demo.value) await tunePicture()
}

function submitTyped(): void {
  const hz = parseFrequency(typed.value)
  typedBad.value = hz === null
  if (hz !== null) void choose(hz)
}

function saveFrame(): void {
  const c = canvas.value
  if (!c) return
  c.toBlob(async (blob) => {
    if (!blob) return
    const name = `tv_${Math.round(carrierHz.value)}Hz_${new Date().toISOString().replace(/[:.]/g, '-')}.png`
    if (!demo.value) {
      bus.emitDecoded(props.deviceId, {
        kind: 'blob',
        mime: 'image/png',
        name,
        bytes: new Uint8Array(await blob.arrayBuffer()),
      })
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = name
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, 'image/png')
}

const gain = computed({
  get: () => node.value?.params.gain ?? gainSpec.value?.default ?? 0,
  set: (v: number) => void devices.configure(props.deviceId, { gain: v }).catch(() => undefined),
})

onBeforeUnmount(() => {
  stopBus()
  void stop()
  worker?.terminate()
  worker = null
})

// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

const line = computed(() => {
  if (!running.value) return ''
  if (stage.value === 'sound')
    return `listening to the sound carrier at ${((carrierHz.value + SOUND_ABOVE_HZ) / 1e6).toFixed(3)} mhz. the picture is paused.`
  const s = status.value
  if (!s) return 'looking for the carrier'
  if (s.carrierDb < 12)
    return `no carrier near ${(carrierHz.value / 1e6).toFixed(2)} mhz. a ham repeater only transmits while someone is on it.`
  if (!s.lineLock) return 'carrier found, looking for line sync'
  if (!s.fieldLock) return 'lines locked, looking for vertical sync'
  return 'locked'
})

const unreachableNote = computed(() =>
  reachable.value
    ? ''
    : `the ${tuner.value ? tuner.value.toLowerCase() : 'tuner'} on this unit does not reach ${(carrierHz.value / 1e6).toFixed(2)} mhz.`,
)
</script>

<template>
  <div>
    <div class="bn-acts">
      <HbButton
        v-for="p in PRESETS"
        :key="p.hz"
        size="sm"
        :aria-pressed="carrierHz === p.hz"
        :disabled="demo"
        @click="choose(p.hz)"
      >
        {{ p.label }}
      </HbButton>
    </div>

    <form class="bn-goto atv-goto" @submit.prevent="submitTyped">
      <label class="bn-klabel" :for="`${uid}-f`">video carrier</label>
      <HbInput
        :id="`${uid}-f`"
        v-model="typed"
        :invalid="typedBad"
        placeholder="421.25"
        inputmode="decimal"
        autocomplete="off"
        :disabled="demo"
      />
      <HbButton size="sm" type="submit" :disabled="demo">go</HbButton>
    </form>
    <p v-if="typedBad" class="bn-note" role="alert">that is not a frequency. try 421.25.</p>
    <p v-if="unreachableNote" class="bn-note" role="alert">
      {{ unreachableNote }}
    </p>

    <div class="bn-acts atv-acts">
      <HbButton v-if="!running" variant="danger" size="sm" :disabled="!reachable" @click="start">
        <template #icon><HbIcon name="play" /></template>
        {{ isSim ? 'watch the demo' : recording ? 'watch this recording' : 'watch' }}
      </HbButton>
      <HbButton v-else size="sm" @click="stop">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton v-if="running && !demo && !recording && stage === 'picture'" size="sm" @click="tuneSound">
        <template #icon><HbIcon name="headphones" /></template>
        hear the sound
      </HbButton>
      <HbButton v-if="running && stage === 'sound'" size="sm" @click="showPicture">
        <template #icon><HbIcon name="image" /></template>
        back to the picture
      </HbButton>
      <HbButton size="sm" :disabled="!fps" @click="saveFrame">
        <template #icon><HbIcon name="floppy-disk" /></template>
        save frame
      </HbButton>
    </div>

    <div class="atv-live" role="status">
      <p v-if="line" class="bn-note">{{ line }}</p>
    </div>
    <p v-if="error" class="bn-note" role="alert">{{ error }}</p>

    <canvas
      ref="canvas"
      class="atv-screen"
      :width="FRAME_W"
      :height="FRAME_H"
      role="img"
      :aria-label="`analog tv picture at ${(carrierHz / 1e6).toFixed(2)} mhz`"
    />

    <div class="bn-meta atv-meta">
      <div>
        <div class="bn-k">carrier</div>
        <div class="bn-v">
          {{ status ? `${status.carrierDb.toFixed(0)} db` : '--' }}
        </div>
      </div>
      <div>
        <div class="bn-k">sync</div>
        <div class="bn-v">
          {{ status?.lineLock ? `${Math.round(status.syncQuality * 100)}%` : '--' }}
        </div>
      </div>
      <div>
        <div class="bn-k">fields</div>
        <div class="bn-v">
          {{ status ? (status.fieldLock ? 'locked' : 'rolling') : '--' }}
        </div>
      </div>
      <div>
        <div class="bn-k">snr</div>
        <div class="bn-v">
          {{ status?.lineLock ? `${status.snrDb.toFixed(0)} db` : '--' }}
        </div>
      </div>
      <div>
        <div class="bn-k">frames</div>
        <div class="bn-v">{{ running ? `${fps}/s` : '--' }}</div>
      </div>
    </div>

    <div class="bn-knobs">
      <InstKnob v-model="brightness" :spec="BRIGHT" />
      <InstKnob v-model="contrast" :spec="CONTRAST" />
      <InstKnob v-if="gainSpec && !isSim && !recording" v-model="gain" :spec="gainSpec" />
    </div>

    <div class="bn-hint">
      <HbIcon name="display" :size="15" />
      <div>
        <b>what it shows</b>
        analog tv, the kind hams still send on 70 cm and 23 cm. the picture rides a carrier, and this window holds the
        carrier and the first megahertz and a half of detail, so the picture is black and white and soft but whole.
        colour sits 3.58 mhz up and the sound 4.5 mhz up, both out of the same window, so the sound is heard by moving
        the radio to it. a repeater transmits only while someone is on it. digital tv cannot be shown at all: its
        picture fills 6 mhz and every part of it is needed.
      </div>
    </div>
  </div>
</template>

<style scoped>
.atv-goto {
  margin-top: var(--hb-s3);
}
.atv-acts {
  margin-top: var(--hb-s3);
}
.atv-screen {
  display: block;
  width: 100%;
  max-width: 640px;
  aspect-ratio: 4 / 3;
  margin-top: var(--hb-s3);
  background: var(--hb-ink);
  border: var(--hb-border) solid var(--hb-ink);
}
.atv-meta {
  margin-top: var(--hb-s3);
}
</style>

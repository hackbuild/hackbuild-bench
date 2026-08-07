<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import type { IconName } from '@virgilvox/hackbuild-ui'
import ArmDialog from '@/components/bench/ArmDialog.vue'
import InstSmeter from '@/components/instruments/InstSmeter.vue'
import { bus } from '@/core/bus/DeviceBus'
import { CAPABILITIES } from '@/core/capabilities'
import type { TransmitSession } from '@/core/drivers/types'
import { AmModulator, FmModulator, ToneSource, bytesToBits } from '@/core/dsp/modulate'
import { SSTV_MODES, encodeSstv, sstvSpec } from '@/core/dsp/sstv'
import type { SstvMode } from '@/core/dsp/sstv'
import { formatHz, fromHex } from '@/core/format'
import { useDevices } from '@/stores/devices'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
// read the list rather than the node computed: the node object keeps its
// identity when it is armed, so a computed chained off it never re-runs.
const armed = computed(
  () =>
    devices.nodes
      .find((n) => n.id === props.deviceId)
      ?.armed.includes(CAPABILITIES.TRANSMIT_RF) ?? false,
)

/** The lowest rate the transmit path runs at, which keeps the modulator cheap. */
const TX_RATE = 2000000
/** Complex samples pushed per queue call for generated sources. */
const TONE_CHUNK = 65536
/** Audio samples handed to a modulator at a time. */
const AUDIO_CHUNK = 4096
const SSTV_RATE = 48000
const SSTV_DEVIATION = 3000

const MODES = [
  { id: 'tone', label: 'tone', icon: 'wave-square' },
  { id: 'audio', label: 'audio file', icon: 'headphones' },
  { id: 'mic', label: 'mic', icon: 'ear-listen' },
  { id: 'data', label: 'data', icon: 'code' },
  { id: 'image', label: 'image', icon: 'image' },
] as const

type StudioMode = (typeof MODES)[number]['id']

const PRESETS = [
  { label: '100.3 fm', mhz: 100.3 },
  { label: '433.92', mhz: 433.92 },
  { label: '146.52', mhz: 146.52 },
  { label: '915.0', mhz: 915 },
]

const DEVIATIONS = [
  { label: 'wide fm, 75 kHz', hz: 75000 },
  { label: 'narrow fm, 5 kHz', hz: 5000 },
  { label: 'very narrow, 2.5 kHz', hz: 2500 },
]

const mode = ref<StudioMode>('tone')
const freqMhz = ref(Number(((node.value?.params.centerHz ?? 100.3e6) / 1e6).toFixed(4)))
const gainDb = ref(20)
const ampOn = ref(false)
const deviationHz = ref(75000)

const sending = ref(false)
const progress = ref(0)
const error = ref<string | null>(null)
const armOpen = ref(false)

const centerHz = computed(() => Math.round(freqMhz.value * 1e6))
const freqOk = computed(() => centerHz.value >= 1e6 && centerHz.value <= 6000e6)

let cancelled = false
let releaseMic: (() => void) | null = null

function txSession(): TransmitSession | null {
  const session = bus.session<TransmitSession>(props.deviceId)
  return session && typeof session.transmitIq === 'function' ? session : null
}

const hasPath = ref(txSession() !== null)

// ---------------------------------------------------------------------------
// tone
// ---------------------------------------------------------------------------

const toneOffsetKhz = ref(0)
const toneSeconds = ref(5)

async function sendTone(session: TransmitSession): Promise<void> {
  const source = new ToneSource(toneOffsetKhz.value * 1000, TX_RATE)
  const total = Math.max(1, Math.round(toneSeconds.value * TX_RATE))
  let done = 0
  while (done < total && !cancelled) {
    const count = Math.min(TONE_CHUNK, total - done)
    await session.transmitIq(source.take(count), TX_RATE)
    done += count
    progress.value = done / total
  }
}

// ---------------------------------------------------------------------------
// audio file
// ---------------------------------------------------------------------------

const audioPcm = shallowRef<Float32Array | null>(null)
const audioRate = ref(48000)
const audioName = ref('')
const audioSeconds = ref(0)
const audioMode = ref<'fm' | 'am'>('fm')
const decoding = ref(false)
const dragOver = ref(false)

/** Peak normalised, so a quiet file still swings the modulator fully. */
function normalise(pcm: Float32Array): void {
  let peak = 0
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i])
    if (v > peak) peak = v
  }
  if (peak < 1e-6) return
  const gain = 0.9 / peak
  for (let i = 0; i < pcm.length; i++) pcm[i] *= gain
}

async function loadAudio(file: File): Promise<void> {
  error.value = null
  decoding.value = true
  let ctx: AudioContext | null = null
  try {
    const bytes = await file.arrayBuffer()
    ctx = new AudioContext()
    const buffer = await ctx.decodeAudioData(bytes)
    const mono = new Float32Array(buffer.length)
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const channel = buffer.getChannelData(c)
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / buffer.numberOfChannels
    }
    normalise(mono)
    audioPcm.value = mono
    audioRate.value = buffer.sampleRate
    audioName.value = file.name
    audioSeconds.value = buffer.duration
  } catch {
    error.value =
      'that file did not decode. the browser reads wav, mp3, m4a, and ogg, and refuses anything it has no decoder for.'
  } finally {
    decoding.value = false
    await ctx?.close()
  }
}

async function sendAudio(session: TransmitSession): Promise<void> {
  const pcm = audioPcm.value
  if (!pcm) return
  const modulator =
    audioMode.value === 'am'
      ? new AmModulator(audioRate.value, TX_RATE)
      : new FmModulator(audioRate.value, TX_RATE, deviationHz.value)

  for (let i = 0; i < pcm.length && !cancelled; i += AUDIO_CHUNK) {
    const block = pcm.subarray(i, Math.min(i + AUDIO_CHUNK, pcm.length))
    await session.transmitIq(modulator.process(block), TX_RATE)
    progress.value = Math.min(1, (i + block.length) / pcm.length)
  }
}

// ---------------------------------------------------------------------------
// mic
// ---------------------------------------------------------------------------

const micOpen = ref(false)
const micDb = ref(-90)
const micError = ref<string | null>(null)
const micSeconds = ref(0)

let micStream: MediaStream | null = null
let micCtx: AudioContext | null = null
let micSource: MediaStreamAudioSourceNode | null = null
let micNode: ScriptProcessorNode | null = null
let micModulator: FmModulator | null = null
let micTarget: TransmitSession | null = null
let micChain: Promise<void> = Promise.resolve()

async function openMic(): Promise<void> {
  if (micOpen.value) return
  micError.value = null
  if (!navigator.mediaDevices?.getUserMedia) {
    micError.value = 'this browser gives no microphone access.'
    return
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
  } catch {
    micError.value = 'mic permission was refused, or no input is attached.'
    return
  }

  const ctx = new AudioContext()
  micCtx = ctx
  micSource = ctx.createMediaStreamSource(micStream)
  // a worklet would need a second module to load, and one mono channel at this
  // block size keeps up in the processor.
  micNode = ctx.createScriptProcessor(4096, 1, 1)
  micNode.onaudioprocess = (event) => onMicBlock(event.inputBuffer.getChannelData(0))
  const silent = ctx.createGain()
  silent.gain.value = 0
  micSource.connect(micNode)
  micNode.connect(silent)
  silent.connect(ctx.destination)
  micOpen.value = true
}

function onMicBlock(block: Float32Array): void {
  let sum = 0
  for (let i = 0; i < block.length; i++) sum += block[i] * block[i]
  const rms = Math.sqrt(sum / Math.max(1, block.length))
  micDb.value = Math.max(-90, 20 * Math.log10(rms + 1e-9))

  const target = micTarget
  const modulator = micModulator
  if (!target || !modulator || cancelled) return
  const copy = new Float32Array(block)
  micSeconds.value += block.length / (micCtx?.sampleRate ?? 48000)
  micChain = micChain
    .then(() => target.transmitIq(modulator.process(copy), TX_RATE))
    .catch(() => undefined)
}

async function closeMic(): Promise<void> {
  micOpen.value = false
  micNode?.disconnect()
  micSource?.disconnect()
  micNode = null
  micSource = null
  for (const track of micStream?.getTracks() ?? []) track.stop()
  micStream = null
  const ctx = micCtx
  micCtx = null
  if (ctx) await ctx.close()
}

async function sendMic(session: TransmitSession): Promise<void> {
  if (!micCtx) throw new Error('the mic is not open, so there is nothing to send.')
  micSeconds.value = 0
  micChain = Promise.resolve()
  micModulator = new FmModulator(micCtx.sampleRate, TX_RATE, deviationHz.value)
  micTarget = session
  await new Promise<void>((resolve) => {
    releaseMic = resolve
  })
  micTarget = null
  micModulator = null
  releaseMic = null
  await micChain
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

const dataText = ref('hello from the bench')
const dataFormat = ref<'text' | 'hex'>('text')
const dataKeying = ref<'ook' | 'afsk'>('ook')
const bitRate = ref(2000)
const repeats = ref(1)

const dataBytes = computed<Uint8Array>(() =>
  dataFormat.value === 'hex'
    ? fromHex(dataText.value)
    : new TextEncoder().encode(dataText.value),
)
const dataBits = computed(() => bytesToBits(dataBytes.value))
const bitsPreview = computed(() => {
  const bits = dataBits.value
  const shown = bits
    .slice(0, 256)
    .join('')
    .replace(/(.{8})/g, '$1 ')
    .trim()
  return bits.length > 256 ? `${shown} and ${bits.length - 256} more` : shown
})
const frameSeconds = computed(
  () => (dataBits.value.length + 32) / Math.max(1, bitRate.value),
)

async function sendData(session: TransmitSession): Promise<void> {
  const bytes = dataBytes.value
  const count = Math.max(1, Math.round(repeats.value))
  for (let i = 0; i < count && !cancelled; i++) {
    await session.transmitFrame(bytes, { bitRate: bitRate.value, mode: dataKeying.value })
    progress.value = (i + 1) / count
    if (i + 1 < count && !cancelled) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
}

// ---------------------------------------------------------------------------
// image
// ---------------------------------------------------------------------------

const sstvMode = ref<SstvMode>('robot36')
const imageName = ref('')
const imagePreview = ref('')
const imageBitmap = shallowRef<ImageBitmap | null>(null)
const imageData = shallowRef<ImageData | null>(null)

const sstvSeconds = computed(() => sstvSpec(sstvMode.value).seconds)

function renderImage(): void {
  const bitmap = imageBitmap.value
  if (!bitmap) return
  const spec = sstvSpec(sstvMode.value)
  const canvas = document.createElement('canvas')
  canvas.width = spec.width
  canvas.height = spec.height
  const g = canvas.getContext('2d')
  if (!g) return
  // cover fit, so the frame is filled and nothing is letterboxed into black.
  const scale = Math.max(spec.width / bitmap.width, spec.height / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  g.drawImage(bitmap, (spec.width - w) / 2, (spec.height - h) / 2, w, h)
  imageData.value = g.getImageData(0, 0, spec.width, spec.height)
  imagePreview.value = canvas.toDataURL('image/png')
}

async function loadImage(file: File): Promise<void> {
  error.value = null
  try {
    imageBitmap.value = await createImageBitmap(file)
    imageName.value = file.name
    renderImage()
  } catch {
    error.value = 'that image did not decode. png, jpeg, gif, and webp all work.'
  }
}

watch(sstvMode, renderImage)

async function sendImage(session: TransmitSession): Promise<void> {
  const image = imageData.value
  if (!image) return
  const audio = encodeSstv(image, sstvMode.value, SSTV_RATE)
  const modulator = new FmModulator(SSTV_RATE, TX_RATE, SSTV_DEVIATION)
  for (let i = 0; i < audio.length && !cancelled; i += AUDIO_CHUNK) {
    const block = audio.subarray(i, Math.min(i + AUDIO_CHUNK, audio.length))
    await session.transmitIq(modulator.process(block), TX_RATE)
    progress.value = Math.min(1, (i + block.length) / audio.length)
  }
}

// ---------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------

function fileFrom(event: Event): File | null {
  const input = event.target as HTMLInputElement
  return input.files?.[0] ?? null
}

function onPickAudio(event: Event): void {
  const file = fileFrom(event)
  if (file) void loadAudio(file)
}

function onPickImage(event: Event): void {
  const file = fileFrom(event)
  if (file) void loadImage(file)
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragOver.value = false
  const file = event.dataTransfer?.files?.[0]
  if (!file) return
  if (mode.value === 'audio') void loadAudio(file)
  if (mode.value === 'image') void loadImage(file)
}

// ---------------------------------------------------------------------------
// the send
// ---------------------------------------------------------------------------

const blocker = computed<string | null>(() => {
  if (mode.value === 'audio' && !audioPcm.value) return 'pick an audio file first.'
  if (mode.value === 'image' && !imageData.value) return 'pick an image first.'
  if (mode.value === 'data' && dataBytes.value.length === 0) return 'the message is empty.'
  if (mode.value === 'mic' && !micOpen.value) {
    return micError.value ?? 'the mic is not open yet.'
  }
  return null
})

const outgoing = computed(() => {
  if (mode.value === 'tone') {
    const offset = toneOffsetKhz.value === 0 ? 'on center' : `${toneOffsetKhz.value} kHz off center`
    return `a steady tone ${offset} for ${toneSeconds.value} s`
  }
  if (mode.value === 'audio') {
    if (!audioPcm.value) return 'nothing yet, pick an audio file'
    const kind = audioMode.value === 'am' ? 'am' : `fm at ${deviationHz.value / 1000} kHz deviation`
    return `${audioName.value}, ${audioSeconds.value.toFixed(0)} s, as ${kind}`
  }
  if (mode.value === 'mic') {
    return `your microphone, live, as fm at ${deviationHz.value / 1000} kHz deviation`
  }
  if (mode.value === 'data') {
    const unit = dataKeying.value === 'afsk' ? 'baud' : 'bits per second'
    const times = repeats.value > 1 ? `, ${repeats.value} times` : ''
    return `${dataBytes.value.length} bytes as ${dataKeying.value} at ${bitRate.value} ${unit}${times}`
  }
  if (!imageData.value) return 'nothing yet, pick an image'
  return `${imageName.value} as ${sstvSpec(sstvMode.value).label} sstv, about ${Math.round(sstvSeconds.value)} s`
})

const jobs: Record<StudioMode, (session: TransmitSession) => Promise<void>> = {
  tone: sendTone,
  audio: sendAudio,
  mic: sendMic,
  data: sendData,
  image: sendImage,
}

async function broadcast(): Promise<void> {
  if (sending.value) return
  error.value = null

  if (!armed.value) {
    armOpen.value = true
    return
  }
  if (!freqOk.value) {
    error.value = 'that frequency is outside the 1 MHz to 6 GHz the radio tunes.'
    return
  }
  const blocked = blocker.value
  if (blocked) {
    error.value = blocked
    return
  }
  const session = txSession()
  if (!session) {
    error.value = 'this radio has no baseband transmit path the studio can drive.'
    return
  }

  cancelled = false
  sending.value = true
  progress.value = 0
  try {
    // half duplex: receive has to end before the transmitter comes up, and the
    // bus needs to know so the rail stops calling the device a streaming one.
    if (node.value?.status === 'streaming') await devices.stop(props.deviceId)
    await session.setTxParams({
      centerHz: centerHz.value,
      sampleRate: TX_RATE,
      txvga: gainDb.value,
      amp: ampOn.value ? 1 : 0,
    })
    await session.beginTransmit()
    await jobs[mode.value](session)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    try {
      await session.endTransmit()
    } catch {
      // the radio may have been unplugged mid send. the panel still settles.
    }
    sending.value = false
    progress.value = 0
  }
}

function stopSending(): void {
  cancelled = true
  releaseMic?.()
  void txSession()
    ?.endTransmit()
    .catch(() => undefined)
}

watch(mode, (next, previous) => {
  if (sending.value) stopSending()
  error.value = null
  if (next === 'mic') void openMic()
  else if (previous === 'mic') void closeMic()
})

onBeforeUnmount(() => {
  stopSending()
  void closeMic()
})
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">out on</div>
        <div class="bn-v is-pink">{{ formatHz(centerHz) }}</div>
      </div>
      <div>
        <div class="bn-k">tx gain</div>
        <div class="bn-v">{{ gainDb }} dB</div>
      </div>
      <div>
        <div class="bn-k">amp</div>
        <div class="bn-v">{{ ampOn ? 'on' : 'off' }}</div>
      </div>
      <div>
        <div class="bn-k">state</div>
        <div class="bn-v" :class="{ 'is-goo': sending }">
          {{ sending ? 'on air' : armed ? 'armed' : 'safe' }}
        </div>
      </div>
    </div>

    <div v-if="sending" class="bn-onair">
      <span class="bn-v">on air {{ formatHz(centerHz) }}</span>
      <span class="bn-grow">{{ outgoing }}</span>
      <div v-if="mode !== 'mic'" class="bn-txbar">
        <i :style="{ width: `${Math.round(progress * 100)}%` }"></i>
      </div>
      <span v-else class="bn-v">{{ micSeconds.toFixed(0) }} s</span>
      <HbButton variant="danger" size="md" @click="stopSending">
        <template #icon><HbIcon name="stop" /></template>
        stop transmitting
      </HbButton>
    </div>

    <div class="bn-seg2" role="tablist" aria-label="what to broadcast">
      <button
        v-for="m in MODES"
        :key="m.id"
        type="button"
        role="tab"
        :aria-selected="mode === m.id"
        :class="{ 'is-on': mode === m.id }"
        @click="mode = m.id"
      >
        <HbIcon :name="(m.icon as IconName)" :size="11" />
        {{ m.label }}
      </button>
    </div>

    <!-- tone -->
    <div v-if="mode === 'tone'" class="bn-knobs">
      <div class="bn-knob" style="min-width: 190px">
        <span class="bn-klabel">offset <b>{{ toneOffsetKhz }} kHz</b></span>
        <input v-model.number="toneOffsetKhz" type="range" min="-500" max="500" step="5" />
      </div>
      <div class="bn-knob" style="min-width: 190px">
        <span class="bn-klabel">length <b>{{ toneSeconds }} s</b></span>
        <input v-model.number="toneSeconds" type="range" min="1" max="30" step="1" />
      </div>
    </div>

    <!-- audio file -->
    <template v-if="mode === 'audio'">
      <div
        class="bn-drop"
        :class="{ 'is-over': dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop="onDrop"
      >
        <input type="file" accept="audio/*" aria-label="audio file" @change="onPickAudio" />
        <span v-if="decoding">decoding</span>
        <b v-else-if="audioName">{{ audioName }}</b>
        <span v-else>drop a track here, or pick one. wav, mp3, m4a, ogg.</span>
        <span v-if="audioPcm">{{ audioSeconds.toFixed(1) }} s at {{ audioRate }} Hz</span>
      </div>
      <div class="bn-knobs">
        <div class="bn-knob">
          <span class="bn-klabel">modulation</span>
          <div class="bn-seg2">
            <button
              type="button"
              :class="{ 'is-on': audioMode === 'fm' }"
              @click="audioMode = 'fm'"
            >
              fm
            </button>
            <button
              type="button"
              :class="{ 'is-on': audioMode === 'am' }"
              @click="audioMode = 'am'"
            >
              am
            </button>
          </div>
        </div>
        <div v-if="audioMode === 'fm'" class="bn-knob" style="min-width: 170px">
          <span class="bn-klabel">deviation</span>
          <select v-model.number="deviationHz">
            <option v-for="d in DEVIATIONS" :key="d.hz" :value="d.hz">{{ d.label }}</option>
          </select>
        </div>
      </div>
    </template>

    <!-- mic -->
    <template v-if="mode === 'mic'">
      <div v-if="micError" class="bn-banner is-warn">
        <HbIcon name="warning" :size="16" />
        <span>{{ micError }}</span>
        <HbButton size="sm" @click="openMic">try again</HbButton>
      </div>
      <div class="bn-knobs">
        <div class="bn-knob" style="min-width: 170px">
          <span class="bn-klabel">deviation</span>
          <select v-model.number="deviationHz">
            <option v-for="d in DEVIATIONS" :key="d.hz" :value="d.hz">{{ d.label }}</option>
          </select>
        </div>
        <div class="bn-knob">
          <span class="bn-klabel">input <b>{{ micOpen ? 'open' : 'closed' }}</b></span>
          <InstSmeter :db="micDb" :floor-db="-60" :ceil-db="0" />
        </div>
      </div>
      <p class="bn-note">
        the mic goes out live while you hold the transmission open. speakers near the mic on the
        same frequency will howl.
      </p>
    </template>

    <!-- data -->
    <template v-if="mode === 'data'">
      <div class="bn-knobs">
        <div class="bn-knob">
          <span class="bn-klabel">payload</span>
          <div class="bn-seg2">
            <button
              type="button"
              :class="{ 'is-on': dataFormat === 'text' }"
              @click="dataFormat = 'text'"
            >
              text
            </button>
            <button
              type="button"
              :class="{ 'is-on': dataFormat === 'hex' }"
              @click="dataFormat = 'hex'"
            >
              hex
            </button>
          </div>
        </div>
        <div class="bn-knob">
          <span class="bn-klabel">keying</span>
          <div class="bn-seg2">
            <button
              type="button"
              :class="{ 'is-on': dataKeying === 'ook' }"
              @click="dataKeying = 'ook'"
            >
              ook
            </button>
            <button
              type="button"
              :class="{ 'is-on': dataKeying === 'afsk' }"
              @click="dataKeying = 'afsk'"
            >
              afsk
            </button>
          </div>
        </div>
        <div class="bn-knob" style="min-width: 150px">
          <span class="bn-klabel">
            {{ dataKeying === 'afsk' ? 'baud' : 'bits per second' }} <b>{{ bitRate }}</b>
          </span>
          <input v-model.number="bitRate" type="number" min="50" max="200000" step="50" />
        </div>
        <div class="bn-knob" style="min-width: 110px">
          <span class="bn-klabel">repeats <b>{{ repeats }}</b></span>
          <input v-model.number="repeats" type="number" min="1" max="20" step="1" />
        </div>
      </div>

      <div class="bn-knobs">
        <div class="bn-knob" style="min-width: 100%">
          <span class="bn-klabel">
            message <b>{{ dataBytes.length }} bytes, {{ frameSeconds.toFixed(2) }} s</b>
          </span>
          <input
            v-model="dataText"
            type="text"
            :placeholder="dataFormat === 'hex' ? 'a1 b2 c3' : 'what goes out'"
          />
        </div>
      </div>

      <div class="bn-bits" aria-label="bits that go out">{{ bitsPreview || 'no bits' }}</div>
    </template>

    <!-- image -->
    <template v-if="mode === 'image'">
      <div
        class="bn-drop"
        :class="{ 'is-over': dragOver }"
        @dragover.prevent="dragOver = true"
        @dragleave="dragOver = false"
        @drop="onDrop"
      >
        <input type="file" accept="image/*" aria-label="image file" @change="onPickImage" />
        <b v-if="imageName">{{ imageName }}</b>
        <span v-else>drop a picture here, or pick one. it is cropped to fill the frame.</span>
      </div>

      <div class="bn-knobs">
        <div class="bn-knob" style="min-width: 190px">
          <span class="bn-klabel">sstv mode</span>
          <select v-model="sstvMode">
            <option v-for="m in SSTV_MODES" :key="m.id" :value="m.id">{{ m.label }}</option>
          </select>
        </div>
      </div>

      <div v-if="imagePreview" class="bn-shot">
        <img :src="imagePreview" :alt="`what goes out, ${imageName}`" />
        <div>
          <div class="bn-k">frame</div>
          <div class="bn-v">
            {{ sstvSpec(sstvMode).width }} x {{ sstvSpec(sstvMode).height }}
          </div>
          <div class="bn-k" style="margin-top: 8px">transmit time</div>
          <div class="bn-v">{{ Math.round(sstvSeconds) }} s</div>
          <p class="bn-note">{{ sstvSpec(sstvMode).blurb }}</p>
        </div>
      </div>
    </template>

    <!-- the radio -->
    <div class="bn-pills" style="margin-top: 12px">
      <button
        v-for="p in PRESETS"
        :key="p.label"
        type="button"
        class="bn-pill"
        :class="{ 'is-on': Math.abs(freqMhz - p.mhz) < 0.0005 }"
        @click="freqMhz = p.mhz"
      >
        {{ p.label }}
      </button>
    </div>

    <div class="bn-knobs">
      <div class="bn-knob" style="min-width: 160px">
        <span class="bn-klabel">frequency <b>MHz</b></span>
        <input v-model.number="freqMhz" type="number" min="1" max="6000" step="0.001" />
      </div>
      <div class="bn-knob" style="min-width: 190px">
        <span class="bn-klabel">tx gain <b>{{ gainDb }} dB</b></span>
        <input v-model.number="gainDb" type="range" min="0" max="47" step="1" />
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">front end amp</span>
        <button
          type="button"
          class="bn-toggle"
          :class="{ 'is-on': ampOn }"
          :aria-pressed="ampOn"
          @click="ampOn = !ampOn"
        >
          <span class="bn-sw"><i></i></span>{{ ampOn ? 'on, plus 14 dB' : 'off' }}
        </button>
      </div>
    </div>

    <div v-if="!freqOk" class="bn-banner is-err">
      <HbIcon name="warning" :size="16" />
      <span>that frequency is outside the 1 MHz to 6 GHz the radio tunes.</span>
    </div>

    <div v-if="!hasPath" class="bn-banner is-warn">
      <HbIcon name="warning" :size="16" />
      <span>this radio has no baseband transmit path the studio can drive.</span>
    </div>

    <div v-if="error" class="bn-banner is-err">
      <HbIcon name="warning" :size="16" />
      <span>{{ error }}</span>
    </div>

    <div v-if="!sending" class="bn-banner">
      <HbIcon name="tower-broadcast" :size="16" />
      <span>going out on {{ formatHz(centerHz) }}: {{ outgoing }}</span>
    </div>

    <HbButton
      v-if="!sending"
      variant="danger"
      size="lg"
      block
      :disabled="!hasPath"
      @click="broadcast"
    >
      <template #icon><HbIcon :name="armed ? 'tower-broadcast' : 'bolt'" /></template>
      {{ armed ? 'broadcast' : 'arm transmit to broadcast' }}
    </HbButton>
    <HbButton v-else variant="danger" size="lg" block @click="stopSending">
      <template #icon><HbIcon name="stop" /></template>
      stop transmitting
    </HbButton>

    <p v-if="blocker && !sending" class="bn-note">{{ blocker }}</p>

    <p class="bn-note">
      transmitting puts energy on the air at {{ formatHz(centerHz) }}. the band you use and the
      antenna on the port are yours to answer for, and most of the spectrum is licensed to
      somebody. into a dummy load none of it leaves the bench. receive stops while a transmission
      runs, since the radio is half duplex.
    </p>

    <ArmDialog
      v-if="armOpen"
      :device-id="deviceId"
      :capability="CAPABILITIES.TRANSMIT_RF"
      @close="armOpen = false"
    />
  </div>
</template>

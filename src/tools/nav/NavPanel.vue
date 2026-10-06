<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId } from 'vue'
import { HbButton, HbIcon, HbInput } from '@virgilvox/hackbuild-ui'
import InstRadar from '@/components/instruments/InstRadar.vue'
import InstKnob from '@/components/instruments/InstKnob.vue'
import { bus } from '@/core/bus/DeviceBus'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { parseFrequency, reaches } from '@/core/dsp/spectrumMath'
import { VorIlsDecoder } from '@/core/decode/navaid/vor'
import type { NavResult } from '@/core/decode/navaid/vor'
import { VorDemoSource, IlsDemoSource, DEMO_VOR_HZ } from '@/core/decode/navaid/demo'
import { useDevices } from '@/stores/devices'
import { useStreamLease } from '@/composables/useStreamLease'
import { emitArtifact } from '@/tools/emit'
import type { Artifact, IqChunk } from '@/core/types'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()
const devices = useDevices()
const lease = useStreamLease(props.deviceId)
const uid = useId()

/** The channel sits this far below the window centre, clear of a zero if tuner's dc spike. */
const OFFSET_HZ = 250_000
const WANT_RATE = 2_400_000

/** Public VOR and ILS frequencies. Facts, but confirm against a current chart. */
const PRESETS: Array<{ hz: number; label: string }> = [
  { hz: 115.6e6, label: 'phoenix pxr vor' },
  { hz: 117.3e6, label: 'tucson tus vor' },
  { hz: 113.3e6, label: 'drake dri vor' },
  { hz: 111.75e6, label: 'phx ils rwy 26' },
  { hz: 108.4e6, label: 'phx ils rwy 8' },
]

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const isSim = computed(() => (node.value ? isSimKind(node.value.kind) : false))
const tuner = computed(() => node.value?.info.tuner ?? '')
const centerSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'centerHz'))
const rateSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'sampleRate'))
const gainSpec = computed(() => node.value?.descriptor.params.find((p) => p.key === 'gain'))

const freqHz = ref(PRESETS[0].hz)
const typed = ref('115.6')
const typedBad = ref(false)
const running = ref(false)
const demo = ref(false)
const demoIls = ref(false)
const error = ref<string | null>(null)
const result = shallowRef<NavResult | null>(null)
/** The field adjust for the cvor/dvor sense and any residual, degrees. */
const trim = ref(0)

const reachable = computed(() => {
  const s = centerSpec.value
  return !s || reaches(s, freqHz.value)
})

function scanRate(): number {
  const s = rateSpec.value
  if (!s?.choices?.length) return s ? Math.min(s.max, Math.max(s.min, WANT_RATE)) : WANT_RATE
  const under = s.choices.filter((r) => r <= WANT_RATE)
  return under.length ? Math.max(...under) : Math.min(...s.choices)
}

const decoder = new VorIlsDecoder()
decoder.onResult = (r) => {
  result.value = r
  if (!demo.value && r.kind === 'vor' && r.radial !== null) {
    emitArtifact(props.deviceId, {
      kind: 'reading',
      name: `vor radial ${r.ident || Math.round(freqHz.value / 1e5) / 10}`,
      value: Math.round(((r.radial + trim.value) % 360 + 360) % 360),
      unit: 'deg',
    })
  }
}

let demoSource: VorDemoSource | IlsDemoSource | null = null
let demoTimer = 0
let demoLast = 0
let want = { centerHz: 0, rate: 0 }
let live = false

function isWanted(c: number, rate: number): boolean {
  return Math.abs(c - want.centerHz) < 5000 && Math.abs(rate - want.rate) < want.rate * 0.01
}

const stopBus = bus.onDeviceArtifact(props.deviceId, (a: Artifact) => {
  if (a.kind !== 'iq' || !live || demo.value) return
  const c = a as IqChunk
  if (!isWanted(c.centerHz, c.sampleRate)) return
  decoder.feed(c.samples, c.sampleRate)
})

async function start(): Promise<void> {
  error.value = null
  result.value = null
  if (isSim.value) {
    demo.value = true
    running.value = true
    demoSource = demoIls.value
      ? new IlsDemoSource({ ddm: -0.08, ident: 'iphx' })
      : new VorDemoSource({ radial: 237, ident: 'pxr' })
    want = { centerHz: DEMO_VOR_HZ + OFFSET_HZ, rate: WANT_RATE }
    decoder.setOffset(-OFFSET_HZ)
    demoLast = performance.now()
    demoTimer = window.setInterval(() => {
      if (!demoSource) return
      const now = performance.now()
      const ms = Math.min(120, now - demoLast)
      demoLast = now
      if (ms > 0) decoder.feed(demoSource.read(ms, want.centerHz, want.rate), want.rate)
    }, 60)
    return
  }
  if (!reachable.value) return
  const t = lease.begin()
  try {
    const g = gainSpec.value
    if (g) await devices.configure(props.deviceId, { gain: g.max })
    const rate = scanRate()
    want = { centerHz: freqHz.value + OFFSET_HZ, rate }
    decoder.setOffset(-OFFSET_HZ)
    live = true
    running.value = true
    await devices.configure(props.deviceId, { centerHz: want.centerHz, sampleRate: rate })
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
  live = false
  running.value = false
  await lease.release()
}

async function retune(hz: number): Promise<void> {
  freqHz.value = hz
  typed.value = (hz / 1e6).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  typedBad.value = false
  result.value = null
  if (running.value && !demo.value) {
    want = { centerHz: hz + OFFSET_HZ, rate: want.rate }
    await devices.configure(props.deviceId, { centerHz: want.centerHz })
  }
}

function submitTyped(): void {
  const hz = parseFrequency(typed.value)
  typedBad.value = hz === null
  if (hz !== null) void retune(hz)
}

const gain = computed({
  get: () => node.value?.params.gain ?? gainSpec.value?.default ?? 0,
  set: (v: number) => void devices.configure(props.deviceId, { gain: v }).catch(() => undefined),
})

onBeforeUnmount(() => {
  stopBus()
  void stop()
})

// ---------------------------------------------------------------------------
// display
// ---------------------------------------------------------------------------

const radial = computed(() => {
  const r = result.value
  if (!r || r.radial === null) return null
  return (((r.radial + trim.value) % 360) + 360) % 360
})
/** The bearing to fly to the station is the reciprocal of the radial. */
const toStation = computed(() => (radial.value === null ? null : (radial.value + 180) % 360))

const blips = computed(() => {
  if (radial.value === null) return []
  return [{ bearing: radial.value, distance: 0.85, label: result.value?.ident || 'vor' }]
})

const ddm = computed(() => result.value?.ddm ?? null)
/** Needle position, -1 full left/low to +1 full right/high. Full scale is 0.155 ddm. */
const needle = computed(() => (ddm.value === null ? 0 : Math.max(-1, Math.min(1, ddm.value / 0.155))))

const status = computed(() => {
  if (!running.value) return ''
  const r = result.value
  if (!r || r.level < 1e-6) return `listening on ${(freqHz.value / 1e6).toFixed(3)} mhz. no carrier yet.`
  if (r.kind === 'vor') return `vor, radial ${radial.value?.toFixed(1)} from the station`
  if (r.kind === 'ils') return 'ils, follow the needle to the centre'
  return 'carrier found, but no vor or ils tones yet'
})
</script>

<template>
  <div>
    <div class="bn-acts">
      <HbButton
        v-for="p in PRESETS"
        :key="p.hz"
        size="sm"
        :aria-pressed="Math.abs(freqHz - p.hz) < 1000"
        :disabled="demo"
        @click="retune(p.hz)"
      >
        {{ p.label }}
      </HbButton>
    </div>

    <form class="bn-goto nav-goto" @submit.prevent="submitTyped">
      <label class="bn-klabel" :for="`${uid}-f`">frequency</label>
      <HbInput :id="`${uid}-f`" v-model="typed" :invalid="typedBad" placeholder="115.6" inputmode="decimal" :disabled="demo" />
      <HbButton size="sm" type="submit" :disabled="demo">go</HbButton>
    </form>
    <p v-if="typedBad" class="bn-note nav-tight" role="alert">that is not a frequency. try 115.6.</p>
    <p v-if="!reachable && !isSim" class="bn-note nav-tight" role="alert">
      the {{ tuner ? tuner.toLowerCase() : 'tuner' }} does not reach {{ (freqHz / 1e6).toFixed(3) }} mhz.
    </p>

    <div class="bn-acts nav-acts">
      <HbButton v-if="!running" variant="danger" size="sm" :disabled="!isSim && !reachable" @click="start">
        <template #icon><HbIcon name="play" /></template>
        {{ isSim ? 'run demo' : 'tune' }}
      </HbButton>
      <HbButton v-else size="sm" @click="stop">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <button
        v-if="isSim && !running"
        type="button"
        class="bn-pack"
        :class="{ 'is-on': demoIls }"
        :aria-pressed="demoIls"
        @click="demoIls = !demoIls"
      >
        demo {{ demoIls ? 'ils' : 'vor' }}
      </button>
    </div>

    <div class="nav-live" role="status">
      <p v-if="status" class="bn-note">{{ status }}</p>
    </div>
    <p v-if="error" class="bn-note" role="alert">{{ error }}</p>

    <div class="bn-meta nav-meta">
      <div>
        <div class="bn-k">ident</div>
        <div class="bn-v">{{ result?.ident || '--' }}</div>
      </div>
      <div v-if="result?.kind === 'vor'">
        <div class="bn-k">radial from</div>
        <div class="bn-v">{{ radial === null ? '--' : `${radial.toFixed(1)} deg` }}</div>
      </div>
      <div v-if="result?.kind === 'vor'">
        <div class="bn-k">to the station</div>
        <div class="bn-v">{{ toStation === null ? '--' : `${toStation.toFixed(1)} deg` }}</div>
      </div>
      <div v-if="result?.kind === 'ils'">
        <div class="bn-k">ddm</div>
        <div class="bn-v">{{ ddm === null ? '--' : ddm.toFixed(3) }}</div>
      </div>
      <div>
        <div class="bn-k">signal</div>
        <div class="bn-v">{{ result && result.level > 1e-6 ? 'present' : 'none' }}</div>
      </div>
    </div>

    <InstRadar
      v-if="result?.kind !== 'ils'"
      :blips="blips"
      :range-label="radial === null ? 'no radial' : `radial ${radial.toFixed(0)}`"
      :size="300"
    />

    <div v-else class="nav-cdi" role="img" :aria-label="`localizer needle ${(needle * 100).toFixed(0)} percent`">
      <div class="nav-cdi-scale">
        <i v-for="d in [-1, -0.5, 0, 0.5, 1]" :key="d" class="nav-cdi-dot" :class="{ 'is-centre': d === 0 }" :style="{ left: (50 + d * 40) + '%' }" />
      </div>
      <div class="nav-cdi-needle" :style="{ left: (50 + needle * 40) + '%' }" />
      <div class="nav-cdi-label">{{ needle < -0.05 ? 'fly left' : needle > 0.05 ? 'fly right' : 'on course' }}</div>
    </div>

    <div class="bn-knobs">
      <div class="bn-field">
        <label :for="`${uid}-trim`">radial trim (cvor/dvor and field offset)</label>
        <input :id="`${uid}-trim`" v-model.number="trim" type="range" min="-180" max="180" step="1" />
        <span class="bn-aside">{{ trim }} deg</span>
      </div>
      <InstKnob v-if="gainSpec && !isSim" v-model="gain" :spec="gainSpec" />
    </div>

    <div class="bn-hint">
      <HbIcon name="location-crosshairs" :size="15" />
      <div>
        <b>what it does</b>
        a vor station sends your bearing from it as the phase between two 30 hz tones, one of
        them on a 9960 hz subcarrier, which this reads as a radial. an ils sends 90 and 150 hz
        tones whose balance is the left or right needle. the morse ident confirms the station.
        the absolute radial depends on whether the station is a conventional or doppler vor, so
        the trim nulls it against a known radial. these are navigation aids, receive only.
      </div>
    </div>
  </div>
</template>

<style scoped>
.nav-goto {
  margin-top: var(--hb-s3);
}
.nav-tight {
  margin-top: 0;
}
.nav-acts {
  margin-top: var(--hb-s3);
}
.nav-meta {
  margin-top: var(--hb-s3);
}
.nav-cdi {
  position: relative;
  height: 80px;
  border: var(--hb-border) solid var(--hb-ink);
  background: var(--hb-void);
  margin: var(--hb-s3) 0;
}
.nav-cdi-scale {
  position: absolute;
  top: 34px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--hb-lit-dim);
}
.nav-cdi-dot {
  position: absolute;
  top: -4px;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  border-radius: 50%;
  background: var(--hb-lit-dim);
}
.nav-cdi-dot.is-centre {
  background: var(--hb-slime);
}
.nav-cdi-needle {
  position: absolute;
  top: 8px;
  bottom: 28px;
  width: 3px;
  margin-left: -1px;
  background: var(--hb-pink);
  transition: left var(--hb-t) linear;
}
.nav-cdi-label {
  position: absolute;
  bottom: 4px;
  left: 0;
  right: 0;
  text-align: center;
  font-family: var(--hb-utility);
  font-size: 10px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--hb-paper);
}
</style>

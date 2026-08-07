<script setup lang="ts">
import { computed, ref } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstPacketList from '@/components/instruments/InstPacketList.vue'
import { AprsDecoder, bearingDeg, distanceKm } from '@/core/decode/aprs'
import type { AprsPacket } from '@/core/decode/aprs'
import { AprsDemoSource } from '@/core/decode/demo'
import { useDecodeAudio } from '@/composables/useDecodeAudio'
import { formatClock } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const MAX = 200

const packets = ref<AprsPacket[]>([])
const homeLat = ref('')
const homeLon = ref('')
const homeError = ref<string | null>(null)

const bad = ref(0)

const decoder = new AprsDecoder()
decoder.onPacket = (p) => {
  packets.value = [p, ...packets.value].slice(0, MAX)
}
decoder.onBadFrame = () => {
  bad.value = decoder.badFrames
}

const audio = useDecodeAudio(props.deviceId, {
  mode: 'fm',
  onAudio: (samples, rate) => decoder.feed(samples, rate),
  demo: () => new AprsDemoSource(),
  demoSpeed: 6,
})

const home = computed(() => {
  const lat = Number(homeLat.value)
  const lon = Number(homeLon.value)
  if (!homeLat.value || !homeLon.value) return null
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  return { lat, lon }
})

const stations = computed(() => {
  const seen = new Map<string, AprsPacket>()
  for (const p of packets.value) if (!seen.has(p.source)) seen.set(p.source, p)
  return [...seen.values()]
})

const positioned = computed(() =>
  stations.value.filter((p) => p.latitude !== undefined && p.longitude !== undefined),
)

function range(p: AprsPacket): string {
  const h = home.value
  if (!h || p.latitude === undefined || p.longitude === undefined) return ''
  const km = distanceKm(h.lat, h.lon, p.latitude, p.longitude)
  const brg = Math.round(bearingDeg(h.lat, h.lon, p.latitude, p.longitude))
  return `${km.toFixed(1)} km at ${String(brg).padStart(3, '0')}`
}

function coords(p: AprsPacket): string {
  if (p.latitude === undefined || p.longitude === undefined) return ''
  return `${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`
}

function describe(p: AprsPacket): string {
  if (p.message) return `to ${p.message.to}: ${p.message.text}`
  if (p.status) return p.status
  const bits: string[] = []
  if (p.latitude !== undefined) bits.push(coords(p))
  if (p.speedKnots !== undefined && p.speedKnots > 0) {
    bits.push(`${p.speedKnots} kt at ${String(p.courseDeg ?? 0).padStart(3, '0')}`)
  }
  if (p.altitudeFt !== undefined) bits.push(`${p.altitudeFt} ft`)
  if (p.comment) bits.push(p.comment)
  if (p.note) bits.push(p.note)
  if (p.path.length) bits.push(`via ${p.path.join(' ')}`)
  return bits.join('  ') || p.info
}

const rows = computed(() =>
  packets.value.map((p) => ({
    id: p.id,
    a: p.source,
    b: `${p.kind}  ${formatClock(p.at)}`,
    c: home.value && p.latitude !== undefined ? range(p) : coords(p),
    decode: describe(p),
    badge: p.kind === 'message' ? 'message' : undefined,
    alert: p.kind === 'message',
  })),
)

function useMyLocation(): void {
  homeError.value = null
  if (!navigator.geolocation) {
    homeError.value = 'this browser has no geolocation'
    return
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      homeLat.value = pos.coords.latitude.toFixed(5)
      homeLon.value = pos.coords.longitude.toFixed(5)
    },
    (err) => {
      homeError.value = `location refused: ${err.message}`
    },
  )
}

function clear(): void {
  packets.value = []
  bad.value = 0
  decoder.reset()
}
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">packets</div>
        <div class="bn-v is-pink">{{ packets.length }}</div>
      </div>
      <div>
        <div class="bn-k">stations</div>
        <div class="bn-v">{{ stations.length }}</div>
      </div>
      <div>
        <div class="bn-k">with position</div>
        <div class="bn-v">{{ positioned.length }}</div>
      </div>
      <div>
        <div class="bn-k">bad frames</div>
        <div class="bn-v is-goo">{{ bad }}</div>
      </div>
      <div>
        <div class="bn-k">source</div>
        <div class="bn-v">{{ audio.isSim.value ? 'demo' : 'fm audio' }}</div>
      </div>
    </div>

    <div class="bn-acts">
      <HbButton v-if="!audio.running.value" variant="danger" size="sm" @click="audio.start()">
        <template #icon><HbIcon name="play" /></template>
        {{ audio.isSim.value ? 'run demo packets' : 'decode' }}
      </HbButton>
      <HbButton v-else size="sm" @click="audio.stop()">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="!packets.length" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
      <HbButton size="sm" @click="useMyLocation">
        <template #icon><HbIcon name="pin" /></template>
        use my location
      </HbButton>
    </div>

    <p v-if="audio.error.value" class="bn-note">{{ audio.error.value }}</p>
    <p v-if="homeError" class="bn-note">{{ homeError }}</p>

    <div v-if="audio.demoRunning.value" class="bn-prog">
      <i :style="{ width: `${Math.round(audio.demoProgress.value * 100)}%` }" />
    </div>

    <div class="bn-knobs">
      <div class="bn-field">
        <label for="aprs-home-lat">home latitude</label>
        <input id="aprs-home-lat" v-model="homeLat" type="text" inputmode="decimal" placeholder="33.4484" />
      </div>
      <div class="bn-field">
        <label for="aprs-home-lon">home longitude</label>
        <input id="aprs-home-lon" v-model="homeLon" type="text" inputmode="decimal" placeholder="-112.0740" />
      </div>
    </div>

    <p v-if="!home && (homeLat || homeLon)" class="bn-note">
      that home position does not parse. use decimal degrees, negative for south and west.
    </p>

    <InstPacketList
      :packets="rows"
      :max="MAX"
      empty-text="no packets yet. aprs is bursty, so a quiet minute is normal."
    />

    <div v-if="positioned.length" class="bn-list" style="margin-top: 10px">
      <div v-for="p in positioned" :key="`pos-${p.id}`" class="bn-row">
        <span class="bn-a">{{ p.source }}</span>
        <span class="bn-b">{{ p.symbol ?? '' }}</span>
        <span class="bn-c">{{ home ? range(p) : coords(p) }}</span>
        <span class="bn-decode">{{ coords(p) }}{{ p.comment ? `  ${p.comment}` : '' }}</span>
      </div>
    </div>

    <div class="bn-hint">
      <HbIcon name="map" :size="15" />
      <div>
        <b>where to find it</b>
        aprs is 144.390 MHz fm across north america, 144.800 MHz across most of europe, and
        145.175 MHz in australia. set the receiver to narrow fm and leave the squelch open,
        since a closed squelch clips the front of a packet and the frame check then fails.
        stations beacon every few minutes, so give it time before deciding nothing is there.
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstSmeter from '@/components/instruments/InstSmeter.vue'
import InstScope from '@/components/instruments/InstScope.vue'
import { Scanner } from '@/core/scanner/engine'
import type { ScanCall, ScanEntry, ScanState } from '@/core/scanner/engine'
import { CHANNEL_GROUPS, SERVICE_LABELS } from '@/core/scanner/conventional'
import type { ConventionalChannel } from '@/core/scanner/conventional'
import { useDevices } from '@/stores/devices'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { useReceiver } from '@/composables/useReceiver'
import { useTranscription } from '@/composables/useTranscription'
import { formatClock, formatHz } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'
import type { DemodMode } from '@/core/dsp/demod'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const stream = useDeviceStream(props.deviceId)
const rx = useReceiver(props.deviceId)
const ears = useTranscription(props.deviceId)

const selectedGroups = ref<string[]>(['weather', 'interop'])
const threshold = ref(-70)
const running = ref(false)
const state = ref<ScanState>('idle')
const entries = shallowRef<ScanEntry[]>([])
const calls = shallowRef<ScanCall[]>([])
const activeCall = ref<ScanCall | null>(null)

const chosen = computed<ConventionalChannel[]>(() =>
  CHANNEL_GROUPS.filter((g) => selectedGroups.value.includes(g.id)).flatMap((g) => g.channels),
)

const scanner = new Scanner(
  {
    tune: async (hz, mode) => {
      rx.setMode(mode as DemodMode)
      await devices.configure(props.deviceId, { centerHz: hz })
    },
    level: () => rx.signalDb.value,
    onState: (s) => {
      state.value = s
      entries.value = [...scanner.list]
    },
    onCall: (c) => {
      activeCall.value = c
      calls.value = [...scanner.callLog]
    },
    onCallEnd: () => {
      activeCall.value = null
      calls.value = [...scanner.callLog]
    },
  },
  { thresholdDb: threshold.value },
)

// each whisper line lands on the call that is open when it arrives, so a busy
// channel becomes readable at a glance.
watch(
  () => ears.lines.value.length,
  () => {
    const line = ears.lines.value[ears.lines.value.length - 1]
    const entry = scanner.current
    if (line && entry && scanner.currentState === 'receiving') {
      scanner.attachTranscript(entry.channel.id, line.text)
      calls.value = [...scanner.callLog]
    }
  },
)

function toggleGroup(id: string): void {
  selectedGroups.value = selectedGroups.value.includes(id)
    ? selectedGroups.value.filter((g) => g !== id)
    : [...selectedGroups.value, id]
  scanner.setChannels(chosen.value)
  entries.value = [...scanner.list]
}

async function start(): Promise<void> {
  if (!chosen.value.length) return
  scanner.setChannels(chosen.value)
  scanner.configure({ thresholdDb: threshold.value })
  await rx.start()
  scanner.start()
  running.value = true
  entries.value = [...scanner.list]
}

async function stop(): Promise<void> {
  scanner.stop()
  running.value = false
  await rx.stop()
}

function hold(): void {
  scanner.hold(!scanner.isHeld)
  state.value = scanner.currentState
}

function skip(): void {
  scanner.skip()
}

function toggleLock(entry: ScanEntry): void {
  scanner.lock(entry.channel.id, !entry.locked)
  entries.value = [...scanner.list]
}

function togglePriority(entry: ScanEntry): void {
  scanner.setPriority(entry.channel.id, !entry.priority)
  entries.value = [...scanner.list]
}

const currentName = computed(() => scanner.current?.channel.name ?? 'nothing selected')
const currentHz = computed(() => scanner.current?.channel.hz ?? 0)

onBeforeUnmount(() => {
  scanner.stop()
  void rx.stop()
})
</script>

<template>
  <div>
    <p class="bn-note" style="margin-top: 0">
      pick what you want to hear, press listen, and the receiver walks the list and stops
      on whatever is talking. these channels are the same everywhere in the country. your
      local fire and police frequencies are not published in a form we can ship, so import
      them below.
    </p>

    <div class="bn-subhead">what to listen to</div>
    <div class="bn-pills">
      <button
        v-for="g in CHANNEL_GROUPS"
        :key="g.id"
        type="button"
        class="bn-pill"
        :class="{ 'is-on': selectedGroups.includes(g.id) }"
        :title="g.blurb"
        @click="toggleGroup(g.id)"
      >
        {{ g.name }}
      </button>
    </div>

    <div class="bn-knobs" style="margin-top: 0">
      <div class="bn-knob" style="min-width: 190px">
        <span class="bn-klabel">squelch <b>{{ threshold }} dB</b></span>
        <input
          v-model.number="threshold"
          type="range"
          min="-100"
          max="-20"
          @change="scanner.configure({ thresholdDb: threshold })"
        />
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton v-if="!running" variant="danger" size="sm" @click="start">
          <template #icon><HbIcon name="play" /></template>
          listen
        </HbButton>
        <HbButton v-else size="sm" @click="stop">
          <template #icon><HbIcon name="stop" /></template>
          stop
        </HbButton>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton size="sm" :disabled="!running" @click="hold">
          {{ scanner.isHeld ? 'release' : 'hold' }}
        </HbButton>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton size="sm" :disabled="!running" @click="skip">skip</HbButton>
      </div>
    </div>

    <div class="bn-meta">
      <div>
        <div class="bn-k">on</div>
        <div class="bn-v is-pink">{{ currentName }}</div>
      </div>
      <div>
        <div class="bn-k">frequency</div>
        <div class="bn-v">{{ formatHz(currentHz) }}</div>
      </div>
      <div>
        <div class="bn-k">state</div>
        <div class="bn-v">{{ state }}</div>
      </div>
      <div>
        <div class="bn-k">channels</div>
        <div class="bn-v">{{ chosen.length }}</div>
      </div>
      <div>
        <div class="bn-k">calls</div>
        <div class="bn-v">{{ calls.length }}</div>
      </div>
    </div>

    <div v-if="activeCall" class="bn-found">
      <HbIcon class="bn-fi" name="tower-broadcast" :size="22" />
      <div class="bn-fx">
        <b>{{ activeCall.name }}</b>
        <div>
          {{ SERVICE_LABELS[activeCall.service as keyof typeof SERVICE_LABELS] ?? activeCall.service }}
          on {{ formatHz(activeCall.hz) }}, peak {{ activeCall.peakDb.toFixed(0) }} dB
        </div>
      </div>
    </div>

    <InstSmeter :db="rx.signalDb.value" />
    <InstScope :bins="stream.fft.value" :height="120" ruled :demo="!running" />

    <div class="bn-subhead" style="margin-top: 14px">
      calls
      <span class="bn-aside">newest first</span>
    </div>
    <div class="bn-list">
      <div v-for="c in calls.slice(0, 40)" :key="c.id" class="bn-row">
        <span class="bn-a">{{ c.name }}</span>
        <span class="bn-b">{{ SERVICE_LABELS[c.service as keyof typeof SERVICE_LABELS] ?? c.service }}</span>
        <span class="bn-c">{{ formatClock(c.startedAt) }}</span>
        <div v-if="c.transcript" class="bn-decode">{{ c.transcript }}</div>
      </div>
      <div v-if="!calls.length" class="bn-row">
        <span class="bn-b">nothing has opened yet. weather radio is always on, so start there to prove the receiver works.</span>
      </div>
    </div>

    <div class="bn-subhead" style="margin-top: 14px">
      channels
      <span class="bn-aside">lock one out to skip it, star it to check it more often</span>
    </div>
    <div class="bn-list">
      <div v-for="e in entries" :key="e.channel.id" class="bn-row">
        <span class="bn-a" :style="e.locked ? 'opacity:.45' : ''">{{ e.channel.name }}</span>
        <span class="bn-b">{{ formatHz(e.channel.hz) }} {{ e.channel.mode }}</span>
        <span class="bn-c">{{ e.hits || '' }}</span>
        <div class="bn-decode">
          <button type="button" class="bn-tinyact" @click="toggleLock(e)">
            {{ e.locked ? 'unlock' : 'lock out' }}
          </button>
          <button type="button" class="bn-tinyact" @click="togglePriority(e)">
            {{ e.priority ? 'unstar' : 'star' }}
          </button>
          <span v-if="e.channel.note"> {{ e.channel.note }}</span>
        </div>
      </div>
      <div v-if="!entries.length" class="bn-row">
        <span class="bn-b">pick a group above</span>
      </div>
    </div>

    <p class="bn-note">
      transcription works here too. turn it on in the tune tab and every call gets a
      caption, which makes a busy channel readable at a glance.
      <span v-if="ears.ready.value"> it is on now.</span>
    </p>
  </div>
</template>

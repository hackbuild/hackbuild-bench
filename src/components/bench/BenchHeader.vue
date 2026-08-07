<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { HbButton, HbIcon, HbMark } from '@virgilvox/hackbuild-ui'
import { useBench } from '@/stores/bench'
import { useSessionLog } from '@/stores/sessionLog'
import { useDevices } from '@/stores/devices'
import { useConnectDialog } from '@/composables/useConnectDialog'

const bench = useBench()
const session = useSessionLog()
const devices = useDevices()
const connect = useConnectDialog()

const elapsed = ref('0:00')
let timer: ReturnType<typeof setInterval> | null = null

const recordLabel = computed(() =>
  session.recording ? `recording ${elapsed.value}` : 'record session',
)

function toggleRecord(): void {
  session.toggle()
  if (session.recording) {
    // jump to the log so it is obvious where the recording goes.
    devices.focus('sessionlog')
    bench.setView('focus')
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - session.startedAt) / 1000)
      elapsed.value = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    }, 500)
  } else if (timer) {
    clearInterval(timer)
    timer = null
    elapsed.value = '0:00'
  }
}

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <header class="bn-top">
    <a class="bn-brand" href="https://hack.build" rel="noreferrer">
      <HbMark :size="30" reversed label="hack.build" />
      <span class="bn-wordmark">hack<b>.build</b></span>
    </a>
    <span class="bn-prod">bench</span>
    <span class="bn-tagline">make things. break things. repeat.</span>

    <div class="bn-grow"></div>

    <button
      class="bn-rec"
      :class="{ 'is-live': session.recording }"
      type="button"
      :aria-pressed="session.recording"
      @click="toggleRecord"
    >
      <span class="bn-d"></span>{{ recordLabel }}
    </button>

    <div class="bn-seg" role="group" aria-label="detail level">
      <button
        type="button"
        :class="{ 'is-on': bench.mode === 'easy' }"
        :aria-pressed="bench.mode === 'easy'"
        @click="bench.setMode('easy')"
      >
        easy
      </button>
      <button
        type="button"
        :class="{ 'is-on': bench.mode === 'advanced' }"
        :aria-pressed="bench.mode === 'advanced'"
        @click="bench.setMode('advanced')"
      >
        advanced
      </button>
    </div>

    <HbButton variant="danger" size="sm" @click="connect.open()">
      <template #icon><HbIcon name="plug-circle-plus" /></template>
      connect
    </HbButton>
  </header>
</template>

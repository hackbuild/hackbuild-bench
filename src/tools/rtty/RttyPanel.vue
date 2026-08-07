<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { RTTY_BAUDS, RTTY_SHIFTS, RttyDecoder } from '@/core/decode/rtty'
import { RttyDemoSource } from '@/core/decode/demo'
import { useDecodeAudio } from '@/composables/useDecodeAudio'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const MAX_CHARS = 8000

const baud = ref(45.45)
const shift = ref(170)
const markHz = ref(2125)
const reverse = ref(false)
const text = ref('')
const errors = ref(0)
const view = ref<HTMLElement | null>(null)

const decoder = new RttyDecoder({
  baud: baud.value,
  shiftHz: shift.value,
  markHz: markHz.value,
  reverse: reverse.value,
})

decoder.onText = (chunk) => {
  const next = text.value + chunk
  text.value = next.length > MAX_CHARS ? next.slice(next.length - MAX_CHARS) : next
  errors.value = decoder.errors
  void nextTick(() => {
    const el = view.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

const audio = useDecodeAudio(props.deviceId, {
  mode: 'usb',
  onAudio: (samples, rate) => decoder.feed(samples, rate),
  demo: () => new RttyDemoSource(markHz.value, shift.value, baud.value),
  demoSpeed: 8,
})

watch([baud, shift, markHz, reverse], () => {
  decoder.setOptions({
    baud: baud.value,
    shiftHz: shift.value,
    markHz: markHz.value,
    reverse: reverse.value,
  })
  errors.value = 0
})

function clear(): void {
  text.value = ''
  errors.value = 0
  decoder.reset()
}
</script>

<template>
  <div>
    <div class="bn-meta">
      <div>
        <div class="bn-k">baud</div>
        <div class="bn-v is-pink">{{ baud }}</div>
      </div>
      <div>
        <div class="bn-k">shift</div>
        <div class="bn-v">{{ shift }} Hz</div>
      </div>
      <div>
        <div class="bn-k">mark</div>
        <div class="bn-v">{{ markHz }} Hz</div>
      </div>
      <div>
        <div class="bn-k">chars</div>
        <div class="bn-v">{{ text.length }}</div>
      </div>
      <div>
        <div class="bn-k">framing errors</div>
        <div class="bn-v is-goo">{{ errors }}</div>
      </div>
    </div>

    <div class="bn-knobs">
      <div class="bn-knob">
        <span class="bn-klabel">baud</span>
        <div class="bn-seg2">
          <button
            v-for="b in RTTY_BAUDS"
            :key="b"
            type="button"
            :aria-pressed="baud === b"
            :class="{ 'is-on': baud === b }"
            @click="baud = b"
          >
            {{ b }}
          </button>
        </div>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">shift</span>
        <div class="bn-seg2">
          <button
            v-for="s in RTTY_SHIFTS"
            :key="s"
            type="button"
            :aria-pressed="shift === s"
            :class="{ 'is-on': shift === s }"
            @click="shift = s"
          >
            {{ s }}
          </button>
        </div>
      </div>
      <div class="bn-knob">
        <span class="bn-klabel">sideband</span>
        <div class="bn-seg2">
          <button
            type="button"
            :aria-pressed="!reverse"
            :class="{ 'is-on': !reverse }"
            @click="reverse = false"
          >
            normal
          </button>
          <button
            type="button"
            :aria-pressed="reverse"
            :class="{ 'is-on': reverse }"
            @click="reverse = true"
          >
            reverse
          </button>
        </div>
      </div>
      <div class="bn-field">
        <label for="rtty-mark">mark tone hz</label>
        <input id="rtty-mark" v-model.number="markHz" type="number" min="300" max="3000" step="5" />
      </div>
    </div>

    <div class="bn-acts">
      <HbButton v-if="!audio.running.value" variant="danger" size="sm" @click="audio.start()">
        <template #icon><HbIcon name="play" /></template>
        {{ audio.isSim.value ? 'run demo text' : 'decode' }}
      </HbButton>
      <HbButton v-else size="sm" @click="audio.stop()">
        <template #icon><HbIcon name="stop" /></template>
        stop
      </HbButton>
      <HbButton size="sm" :disabled="!text.length" @click="clear">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
    </div>

    <p v-if="audio.error.value" class="bn-note">{{ audio.error.value }}</p>

    <div v-if="audio.demoRunning.value" class="bn-prog">
      <i :style="{ width: `${Math.round(audio.demoProgress.value * 100)}%` }" />
    </div>

    <div ref="view" class="bn-term" role="log" aria-live="polite" aria-label="decoded rtty text">
      <span v-if="text">{{ text }}</span>
      <span v-else class="is-dim">waiting for characters</span>
    </div>

    <div class="bn-hint">
      <HbIcon name="code" :size="15" />
      <div>
        <b>reading it</b>
        rtty lives at the low end of the hf bands, 14.080 to 14.099 and 7.040 MHz among
        others, received on usb. tune so the two tones sit at mark and space, then watch the
        framing error count: it drops to near zero once the tuning and the shift are right.
        solid gibberish with no framing errors usually means the sideband is inverted, so
        switch to reverse.
      </div>
    </div>
  </div>
</template>

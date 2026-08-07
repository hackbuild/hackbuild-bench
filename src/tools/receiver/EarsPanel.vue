<script setup lang="ts">
import { computed } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { useTranscription } from '@/composables/useTranscription'
import { formatClock } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const ears = useTranscription(props.deviceId)

const tag = computed(() => {
  if (ears.error.value) return 'unavailable'
  if (ears.loading.value) return `loading ${ears.progress.value}%`
  if (ears.ready.value) return `${ears.model.value}  ${ears.backend.value}  on`
  return 'off'
})
</script>

<template>
  <div class="bn-whisper">
    <div class="bn-wh">
      <HbIcon name="ear-listen" :size="15" />ears
      <span class="bn-tag">{{ tag }}</span>
    </div>
    <div class="bn-wbody">
      <p v-if="ears.error.value" style="font-size: 13px; color: var(--hb-lit-warn)">
        {{ ears.error.value }}
      </p>
      <p v-else-if="!ears.ready.value && !ears.loading.value" style="font-size: 13px">
        turn on transcription to caption whatever you are listening to. the model
        downloads once, then runs on this machine and nothing leaves it.
      </p>
      <div v-for="(line, i) in ears.lines.value" :key="i">
        <span class="bn-t">{{ formatClock(line.at) }}</span>{{ line.text }}
      </div>
    </div>
  </div>

  <div class="bn-acts" style="margin-top: 8px">
    <HbButton
      v-if="!ears.ready.value"
      size="sm"
      :loading="ears.loading.value"
      @click="ears.enable()"
    >
      <template #icon><HbIcon name="ear-listen" /></template>
      turn on transcription
    </HbButton>
    <HbButton v-else size="sm" @click="ears.disable()">turn off</HbButton>
    <HbButton v-if="ears.lines.value.length" size="sm" @click="ears.clear()">clear</HbButton>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import InstScope from '@/components/instruments/InstScope.vue'
import InstWaterfall from '@/components/instruments/InstWaterfall.vue'
import InstKnob from '@/components/instruments/InstKnob.vue'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'
import { useDeviceStream } from '@/composables/useDeviceStream'
import { formatHz, formatRate } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()
const bench = useBench()
const stream = useDeviceStream(props.deviceId)

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const streaming = computed(() => node.value?.status === 'streaming')
const params = computed(() => node.value?.descriptor.params ?? [])

const visible = computed(() =>
  params.value.filter((p) => bench.advanced || ['centerHz', 'gain', 'channel'].includes(p.key)),
)

function model(key: string) {
  return computed({
    get: () => node.value?.params[key] ?? 0,
    set: (v: number) => void devices.configure(props.deviceId, { [key]: v }),
  })
}

const span = computed(() => {
  const rate = stream.sampleRate.value || node.value?.params.sampleRate || 0
  return rate
})

const lowEdge = computed(() => stream.centerHz.value - span.value / 2)
const highEdge = computed(() => stream.centerHz.value + span.value / 2)

const canWideSweep = computed(() =>
  (node.value?.descriptor.params ?? []).some((p) => p.key === 'sweepLowHz'),
)

async function sweep(): Promise<void> {
  // the hackrf steps a real wideband panorama; other radios show the
  // instantaneous window they are tuned to.
  const mode = node.value?.kind === 'ubertooth' ? 'spectrum' : canWideSweep.value ? 'sweep' : 'rx'
  await devices.start(props.deviceId, mode)
}

async function halt(): Promise<void> {
  await devices.stop(props.deviceId)
}

onBeforeUnmount(() => {
  if (streaming.value) void devices.stop(props.deviceId).catch(() => undefined)
})
</script>

<template>
  <div>
    <div class="bn-knobs" style="margin-top: 0">
      <InstKnob
        v-for="p in visible"
        :key="p.key"
        v-model="model(p.key).value"
        :spec="p"
      />
      <div class="bn-knob">
        <span class="bn-klabel">&nbsp;</span>
        <HbButton v-if="!streaming" variant="danger" size="sm" @click="sweep">
          <template #icon><HbIcon name="wave-square" /></template>
          sweep
        </HbButton>
        <HbButton v-else size="sm" @click="halt">
          <template #icon><HbIcon name="stop" /></template>
          stop
        </HbButton>
      </div>
    </div>

    <p v-if="canWideSweep && !bench.advanced" class="bn-note" style="margin-top: 0">
      sweep steps the tuner across a range and stitches the result into one wide picture.
      switch to advanced to set the range, the default is 400 to 500 MHz.
    </p>

    <InstScope :bins="stream.fft.value" :height="180" ruled :demo="!streaming" />
    <InstWaterfall
      :bins="stream.fft.value"
      :height="110"
      :demo="!streaming"
      style="margin-top: 8px"
    />

    <div class="bn-reads">
      <div class="bn-read">
        <div class="bn-k">center</div>
        <div class="bn-v is-pink">{{ formatHz(stream.centerHz.value) }}</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">span</div>
        <div class="bn-v">{{ formatRate(span) }}</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">low</div>
        <div class="bn-v">{{ formatHz(lowEdge, 2) }}</div>
      </div>
      <div class="bn-read">
        <div class="bn-k">high</div>
        <div class="bn-v">{{ formatHz(highEdge, 2) }}</div>
      </div>
    </div>

    <p v-for="(reason, cap) in node?.descriptor.limits ?? {}" :key="cap" class="bn-note">
      {{ reason }}
    </p>
  </div>
</template>

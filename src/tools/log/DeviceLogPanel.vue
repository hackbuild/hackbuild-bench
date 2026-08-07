<script setup lang="ts">
import { computed } from 'vue'
import { CAPABILITY_LABELS, impactOf } from '@/core/capabilities'
import { useDevices } from '@/stores/devices'
import { formatClock } from '@/core/format'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const devices = useDevices()

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const entries = computed(() =>
  devices.logs.filter((l) => l.deviceId === props.deviceId).slice(-200).reverse(),
)

const info = computed(() => Object.entries(node.value?.info ?? {}))
const limits = computed(() => Object.entries(node.value?.descriptor.limits ?? {}))
</script>

<template>
  <div v-if="node">
    <div class="bn-subhead">what it told us</div>
    <div class="bn-dinfo">
      <template v-for="[k, v] in info" :key="k">
        <span class="bn-k">{{ k }}</span>
        <span class="bn-v">{{ v }}</span>
      </template>
      <span class="bn-k">transport</span>
      <span class="bn-v">{{ node.transport }}</span>
      <span class="bn-k">connected</span>
      <span class="bn-v">{{ formatClock(node.connectedAt) }}</span>
    </div>

    <div class="bn-subhead" style="margin-top: 14px">capabilities</div>
    <div class="bn-fcaps">
      <span
        v-for="c in node.capabilities"
        :key="c"
        class="bn-chipx"
        :class="{ 'is-pink': impactOf(c) === 'consequential' }"
        :title="impactOf(c) === 'consequential' ? 'needs arming before it will run' : 'free to use'"
      >
        {{ CAPABILITY_LABELS[c] ?? c }}
      </span>
    </div>

    <div v-if="limits.length" class="bn-subhead" style="margin-top: 14px">what it cannot do</div>
    <p v-for="[cap, reason] in limits" :key="cap" class="bn-note" style="margin-top: 4px">
      {{ CAPABILITY_LABELS[cap as keyof typeof CAPABILITY_LABELS] ?? cap }}: {{ reason }}
    </p>

    <div class="bn-subhead" style="margin-top: 14px">log</div>
    <div class="bn-list">
      <div v-for="(e, i) in entries" :key="i" class="bn-row">
        <span class="bn-a">{{ e.message }}</span>
        <span class="bn-b"></span>
        <span class="bn-c">{{ formatClock(e.at) }}</span>
      </div>
      <div v-if="!entries.length" class="bn-row">
        <span class="bn-b">nothing logged yet</span>
      </div>
    </div>
  </div>
</template>

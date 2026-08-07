<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import { HbToaster } from '@virgilvox/hackbuild-ui'
import BenchHeader from '@/components/bench/BenchHeader.vue'
import BenchStatus from '@/components/bench/BenchStatus.vue'
import DeviceRail from '@/components/bench/DeviceRail.vue'
import ViewBar from '@/components/bench/ViewBar.vue'
import ControlPlane from '@/components/bench/ControlPlane.vue'
import RackView from '@/components/bench/RackView.vue'
import BenchTool from '@/components/bench/BenchTool.vue'
import EmptyBench from '@/components/bench/EmptyBench.vue'
import ConnectDialog from '@/components/bench/ConnectDialog.vue'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'
import { bus } from '@/core/bus/DeviceBus'
import { benchTools } from '@/tools/registry'

const devices = useDevices()
const bench = useBench()

/** The rail selects either a device id or a bench tool id. */
const selectedTool = computed(() =>
  benchTools().find((t) => t.id === devices.focusId) ?? null,
)

const crumb = computed(() => {
  if (selectedTool.value) return selectedTool.value.label
  return devices.focused?.label ?? 'nothing selected'
})

onBeforeUnmount(() => {
  void bus.detachAll()
})
</script>

<template>
  <div class="bn-app">
    <BenchHeader />

    <DeviceRail />

    <div class="bn-main">
      <ViewBar :crumb="crumb" />
      <div class="bn-stage">
        <RackView v-if="bench.view === 'rack'" />
        <BenchTool v-else-if="selectedTool" :tool="selectedTool" />
        <ControlPlane v-else-if="devices.focused" :node="devices.focused" />
        <EmptyBench v-else />
      </div>
    </div>

    <BenchStatus :focus="crumb" />

    <ConnectDialog />
    <HbToaster />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
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

/**
 * The rail selects a device or a bench tool through the same id, so nothing
 * being focused is a real state. With devices on the bench it is the wrong
 * one to show: the empty bench claims there is no hardware while the rail
 * lists it. Fall back to the first device.
 */
watch(
  () => [devices.nodes, devices.focusId],
  () => {
    if (selectedTool.value || devices.focused) return
    // not while it is still opening: its capabilities are not known yet, so
    // the only tool that fits is the info panel and the rail would land there
    // instead of on what the device is for.
    const first = devices.nodes.find((n) => n.status !== 'opening')
    if (first) devices.focus(first.id)
  },
  { immediate: true },
)

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

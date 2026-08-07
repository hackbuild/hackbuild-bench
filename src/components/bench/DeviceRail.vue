<script setup lang="ts">
import { computed } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import type { IconName } from '@virgilvox/hackbuild-ui'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'
import { useConnectDialog } from '@/composables/useConnectDialog'
import { useDemoMode } from '@/composables/useDemoMode'
import { benchTools } from '@/tools/registry'
import type { DeviceNode } from '@/core/types'

const devices = useDevices()
const bench = useBench()
const connect = useConnectDialog()
const demo = useDemoMode()

const tools = computed(() => benchTools())

function dotClass(node: DeviceNode): string {
  if (node.status === 'error') return 'is-err'
  if (node.status === 'streaming') return 'is-live'
  if (node.status === 'opening') return 'is-warn'
  if (node.status === 'idle') return 'is-idle'
  return ''
}

function subtitle(node: DeviceNode): string {
  if (node.status === 'error') return 'error'
  if (node.status === 'streaming') return 'streaming'
  if (node.status === 'opening') return 'opening'
  return node.transport
}

function select(id: string): void {
  devices.focus(id)
  bench.setView('focus')
}
</script>

<template>
  <nav class="bn-rail" aria-label="bench devices and tools">
    <div class="bn-railsec">devices</div>

    <div v-if="devices.nodes.length" class="bn-devs">
      <button
        v-for="node in devices.nodes"
        :key="node.id"
        type="button"
        class="bn-dev"
        :class="{ 'is-on': devices.focusId === node.id && bench.view === 'focus' }"
        :aria-current="devices.focusId === node.id ? 'true' : undefined"
        @click="select(node.id)"
      >
        <span class="bn-dot" :class="dotClass(node)"></span>
        <HbIcon class="bn-di" :name="(node.descriptor.icon as IconName)" :size="14" />
        <span class="bn-col">
          <span class="bn-nm">{{ node.label }}</span>
          <span class="bn-st">{{ subtitle(node) }}</span>
        </span>
      </button>
    </div>

    <p v-else class="bn-railempty">
      nothing connected. plug something in and hit connect, or open a tool below to
      look at a file.
    </p>

    <div class="bn-railsec">tools</div>
    <div class="bn-devs">
      <button
        v-for="t in tools"
        :key="t.id"
        type="button"
        class="bn-dev"
        :class="{ 'is-on': devices.focusId === t.id && bench.view === 'focus' }"
        @click="select(t.id)"
      >
        <span class="bn-dot is-idle"></span>
        <HbIcon class="bn-di" :name="(t.icon as IconName)" :size="14" />
        <span class="bn-col">
          <span class="bn-nm">{{ t.label }}</span>
          <span class="bn-st">{{ t.blurb ?? 'tool' }}</span>
        </span>
      </button>
    </div>

    <div class="bn-railact">
      <HbButton size="sm" @click="connect.open()">
        <template #icon><HbIcon name="plug-circle-plus" /></template>
        connect a device
      </HbButton>
      <HbButton size="sm" :loading="demo.busy.value" @click="demo.toggle()">
        <template #icon><HbIcon name="flask" /></template>
        {{ demo.on.value ? 'leave demo mode' : 'demo mode' }}
      </HbButton>
    </div>
  </nav>
</template>

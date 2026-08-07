<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import type { IconName } from '@virgilvox/hackbuild-ui'
import RouteControl from './RouteControl.vue'
import ArmDialog from './ArmDialog.vue'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'
import { toolsForDevice, unmetToolsForDevice } from '@/tools/registry'
import type { DeviceNode } from '@/core/types'
import { impactOf } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'

interface Props {
  node: DeviceNode
}

const props = defineProps<Props>()

const devices = useDevices()
const bench = useBench()

const tools = computed(() => toolsForDevice(props.node, bench.advanced))
const unmet = computed(() => unmetToolsForDevice(props.node, bench.advanced))

const activeId = ref<string>('')

watch(
  [tools, () => props.node.id],
  () => {
    if (!tools.value.some((t) => t.id === activeId.value)) {
      activeId.value = tools.value[0]?.id ?? ''
    }
  },
  { immediate: true },
)

const active = computed(() => tools.value.find((t) => t.id === activeId.value) ?? null)

/** Consequential capabilities this unit provides, armed or not. */
const armable = computed(() =>
  props.node.capabilities.filter((c) => impactOf(c) === 'consequential'),
)

const armPending = ref<Capability | null>(null)

async function disconnect(): Promise<void> {
  await devices.disconnect(props.node.id)
}
</script>

<template>
  <section class="bn-plane">
    <div class="bn-planebar">
      <div class="bn-pt">
        <HbIcon :name="(node.descriptor.icon as IconName)" :size="16" />{{ node.label }}
      </div>
      <span
        v-if="node.status === 'error'"
        class="bn-badge is-warn"
      >{{ node.status }}</span>
      <span v-else class="bn-badge">{{ node.transport }}</span>
      <span class="bn-planedesc">{{ node.descriptor.blurb }}</span>

      <div class="bn-grow"></div>

      <RouteControl :device-id="node.id" />

      <button
        v-for="cap in armable"
        :key="cap"
        type="button"
        class="bn-recbtn"
        @click="armPending = cap"
      >
        <span class="bn-d" v-if="!node.armed.includes(cap)"></span>
        {{ node.armed.includes(cap) ? `${cap} armed` : `arm ${cap}` }}
      </button>

      <HbButton size="sm" @click="disconnect">
        <template #icon><HbIcon name="power" /></template>
        let go
      </HbButton>
    </div>

    <div class="bn-pcard">
      <div v-if="node.error" class="bn-banner is-err">
        <HbIcon name="warning" />
        <span>{{ node.error }}</span>
      </div>

      <div v-if="tools.length > 1" class="bn-subtabs" role="tablist">
        <button
          v-for="t in tools"
          :key="t.id"
          type="button"
          role="tab"
          class="bn-subtab"
          :class="{ 'is-on': t.id === activeId, 'is-adv': t.advanced }"
          :aria-selected="t.id === activeId"
          @click="activeId = t.id"
        >
          <HbIcon :name="(t.icon as IconName)" :size="11" />{{ t.label }}
        </button>
        <button
          v-for="u in unmet"
          :key="u.tool.id"
          type="button"
          class="bn-subtab"
          disabled
          :title="`needs ${u.missing.join(', ')}, which this device does not provide`"
        >
          <HbIcon :name="(u.tool.icon as IconName)" :size="11" />{{ u.tool.label }}
        </button>
      </div>

      <component :is="active.component" v-if="active" :device-id="node.id" :key="node.id + active.id" />

      <p v-else class="bn-note">
        this device reported no capabilities the bench has a tool for. its raw info is
        under the device log.
      </p>
    </div>

    <ArmDialog
      v-if="armPending"
      :device-id="node.id"
      :capability="armPending"
      @close="armPending = null"
    />
  </section>
</template>

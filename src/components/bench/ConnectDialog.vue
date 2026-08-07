<script setup lang="ts">
import { computed, ref } from 'vue'
import { HbButton, HbIcon, HbModal } from '@virgilvox/hackbuild-ui'
import type { IconName } from '@virgilvox/hackbuild-ui'
import { DRIVERS } from '@/core/drivers/registry'
import { transportSupport } from '@/core/transport/support'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'
import { useConnectDialog } from '@/composables/useConnectDialog'
import type { DeviceDriver } from '@/core/drivers/types'
import type { TransportKind } from '@/core/types'

const devices = useDevices()
const bench = useBench()
const dialog = useConnectDialog()

const support = transportSupport()
const expanded = ref<string | null>(null)
const fields = ref<Record<string, string>>({})

/** A driver is reachable when at least one of its transports is available. */
function reachable(d: DeviceDriver): boolean {
  return d.descriptor.transports.some((t) => support[t].available)
}

function blockedReason(d: DeviceDriver): string {
  const reasons = d.descriptor.transports
    .map((t) => support[t].reason)
    .filter((r): r is string => Boolean(r))
  return reasons[0] ?? 'this browser does not expose the api this device needs'
}

function firstTransport(d: DeviceDriver): TransportKind {
  return d.descriptor.transports.find((t) => support[t].available) ?? d.descriptor.transports[0]
}

function toggle(d: DeviceDriver): void {
  if (!d.descriptor.accessFields?.length) {
    void go(d, firstTransport(d))
    return
  }
  expanded.value = expanded.value === d.descriptor.kind ? null : d.descriptor.kind
  if (expanded.value) {
    fields.value = Object.fromEntries(
      d.descriptor.accessFields.map((f) => [f.key, f.default ?? '']),
    )
  }
}

async function go(d: DeviceDriver, transport: TransportKind): Promise<void> {
  const node = await devices.connect(d.descriptor.kind, transport, { ...fields.value })
  if (node) {
    bench.setView('focus')
    dialog.close()
    expanded.value = null
  }
}

const sorted = computed(() =>
  [...DRIVERS].sort((a, b) => Number(reachable(b)) - Number(reachable(a))),
)
</script>

<template>
  <HbModal
    v-model="dialog.isOpen.value"
    title="connect a device"
    :width="640"
    @close="expanded = null"
  >
    <p class="bn-note" style="margin-top: 0">
      everything here talks to the hardware straight from this tab. no helper app, no
      bridge. picking a device opens the browser permission prompt.
    </p>

    <div v-if="devices.lastError" class="bn-banner is-err">
      <HbIcon name="warning" />
      <span>{{ devices.lastError }}</span>
    </div>

    <div class="bn-devs" style="padding: 0; gap: 10px; margin-top: 12px">
      <div v-for="d in sorted" :key="d.descriptor.kind">
        <button
          type="button"
          class="bn-dev"
          :disabled="!reachable(d)"
          :style="!reachable(d) ? 'opacity:.45' : ''"
          @click="toggle(d)"
        >
          <span class="bn-dot" :class="reachable(d) ? 'is-idle' : 'is-warn'"></span>
          <HbIcon class="bn-di" :name="(d.descriptor.icon as IconName)" :size="14" />
          <span class="bn-col">
            <span class="bn-nm">{{ d.descriptor.name }}</span>
            <span class="bn-st">
              {{ reachable(d) ? d.descriptor.blurb : blockedReason(d) }}
            </span>
          </span>
          <span class="bn-chipx">{{ d.descriptor.transports.join(' or ') }}</span>
        </button>

        <div
          v-if="expanded === d.descriptor.kind && d.descriptor.accessFields"
          class="bn-capcard"
          style="margin-top: 6px"
        >
          <div class="bn-knobs" style="margin-top: 0">
            <label
              v-for="f in d.descriptor.accessFields"
              :key="f.key"
              class="bn-knob"
            >
              <span class="bn-klabel">{{ f.label }}</span>
              <input
                v-model="fields[f.key]"
                :type="f.type === 'password' ? 'password' : 'text'"
                :placeholder="f.placeholder"
              />
            </label>
          </div>
          <div class="bn-acts">
            <HbButton
              variant="danger"
              size="sm"
              :loading="devices.connecting"
              @click="go(d, firstTransport(d))"
            >
              connect
            </HbButton>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <HbButton @click="dialog.close()">done</HbButton>
    </template>
  </HbModal>
</template>

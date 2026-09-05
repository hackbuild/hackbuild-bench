<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { HbButton, HbIcon, HbModal } from '@virgilvox/hackbuild-ui'
import { ARM_NOTES, CAPABILITY_LABELS } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import { useDevices } from '@/stores/devices'

interface Props {
  deviceId: string
  capability: Capability
}

const props = defineProps<Props>()
const emit = defineEmits<{ close: [] }>()

const devices = useDevices()
// HbModal moves focus, traps tab and locks the page behind only when the model
// transitions, and every call site creates this with v-if.
const open = ref(false)

onMounted(() => {
  open.value = true
})

const node = computed(() => devices.nodes.find((n) => n.id === props.deviceId) ?? null)
const armed = computed(() => node.value?.armed.includes(props.capability) ?? false)
const label = computed(() => CAPABILITY_LABELS[props.capability] ?? props.capability)
const note = computed(() => ARM_NOTES[props.capability] ?? '')

function confirm(): void {
  if (armed.value) devices.disarm(props.deviceId, props.capability)
  else devices.arm(props.deviceId, props.capability)
  void close()
}

async function close(): Promise<void> {
  open.value = false
  // the parent drops this with v-if on the close event, which would cancel the
  // library's own watcher before it puts page scroll and focus back.
  await nextTick()
  emit('close')
}
</script>

<template>
  <HbModal v-model="open" :title="armed ? `disarm ${label}` : `arm ${label}`" :width="520" @close="close">
    <p class="bn-note" style="margin-top: 0">{{ note }}</p>
    <p v-if="!armed" class="bn-note">
      arming stays on for this session and for this device only. disconnecting clears it.
    </p>

    <template #footer>
      <HbButton @click="close">cancel</HbButton>
      <HbButton :variant="armed ? 'secondary' : 'danger'" @click="confirm">
        <template #icon><HbIcon :name="armed ? 'lock' : 'bolt'" /></template>
        {{ armed ? 'disarm' : `arm ${label}` }}
      </HbButton>
    </template>
  </HbModal>
</template>

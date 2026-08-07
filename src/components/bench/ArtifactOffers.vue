<script setup lang="ts">
import { computed, ref } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import type { IconName } from '@virgilvox/hackbuild-ui'
import ArmDialog from './ArmDialog.vue'
import { bus } from '@/core/bus/DeviceBus'
import { missingOffersFor, offersFor } from '@/core/actions/offers'
import type { Offer } from '@/core/actions/offers'
import { useBench } from '@/stores/bench'
import { useDevices } from '@/stores/devices'
import { useAutomations } from '@/stores/automations'
import { toHex } from '@/core/format'
import type { Artifact, PacketRecord } from '@/core/types'
import type { Capability } from '@/core/capabilities'
import type { DeviceSession } from '@/core/drivers/types'

interface Props {
  artifact: Artifact
}

const props = defineProps<Props>()

const bench = useBench()
const devices = useDevices()
const rules = useAutomations()

/** Recomputes as devices come and go, so plugging in a radio adds actions. */
const offers = computed(() => {
  void devices.nodes
  return offersFor(props.artifact, {
    bus,
    sendToAnalysis: (label, bytes) => bench.sendToAnalysis(label, bytes),
  })
})

const missing = computed(() => {
  void devices.nodes
  return missingOffersFor(props.artifact, bus)
})

const arming = ref<{ deviceId: string; capability: Capability } | null>(null)
const outcome = ref<string | null>(null)
const preview = ref<{ deviceId: string; label: string; bytes: Uint8Array } | null>(null)

type TransmitSession = DeviceSession & {
  replayFrame?(bytes: Uint8Array): Promise<void>
  transmit?(bytes: Uint8Array): Promise<void>
}

function bytesOf(): Uint8Array {
  if (props.artifact.kind === 'packet') return (props.artifact as PacketRecord).bytes
  if (props.artifact.kind === 'blob') return props.artifact.bytes
  return new Uint8Array(0)
}

function summaryOf(): string {
  if (props.artifact.kind === 'packet') {
    return (props.artifact as PacketRecord).summary ?? (props.artifact as PacketRecord).proto
  }
  return props.artifact.kind
}

async function take(offer: Offer): Promise<void> {
  outcome.value = null

  if (offer.id === 'analyse') {
    bench.sendToAnalysis(summaryOf(), bytesOf())
    devices.focus('analysis')
    return
  }

  if (offer.arms && offer.target && !offer.armed) {
    arming.value = { deviceId: offer.target.id, capability: offer.arms }
    return
  }

  if (offer.id.startsWith('replay:') || offer.id.startsWith('retransmit:')) {
    // the frame is shown before anything goes out, so a replay is always a
    // deliberate send of something you have looked at.
    preview.value = {
      deviceId: offer.target?.id ?? '',
      label: offer.target?.label ?? 'the radio',
      bytes: bytesOf(),
    }
    return
  }

  if (offer.id.startsWith('gatt:') && offer.target) {
    devices.focus(offer.target.id)
    outcome.value = `open the gatt tool on ${offer.target.label} and pick this address`
    return
  }

  if (offer.id.startsWith('trigger:') && offer.target) {
    rules.addForArtifact(props.artifact.source, summaryOf(), offer.target.id)
    devices.focus('automations')
    return
  }

  if (offer.id.startsWith('reply:') && offer.target) {
    devices.focus(offer.target.id)
    outcome.value = `open the mesh tool on ${offer.target.label} to reply`
  }
}

async function send(): Promise<void> {
  const frame = preview.value
  if (!frame) return
  const session = bus.session<TransmitSession>(frame.deviceId)
  try {
    if (session?.replayFrame) await session.replayFrame(frame.bytes)
    else if (session?.transmit) await session.transmit(frame.bytes)
    else throw new Error(`${frame.label} has no replay path yet`)
    outcome.value = `sent ${frame.bytes.length} bytes through ${frame.label}`
  } catch (err) {
    outcome.value = err instanceof Error ? err.message : String(err)
  } finally {
    preview.value = null
  }
}
</script>

<template>
  <div>
    <div class="bn-subhead" style="margin-top: 12px">
      what you can do with this
      <span class="bn-aside">grows as you plug more in</span>
    </div>

    <div class="bn-acts">
      <HbButton
        v-for="o in offers"
        :key="o.id"
        size="sm"
        :variant="o.arms && !o.armed ? 'secondary' : 'primary'"
        :title="o.detail"
        @click="take(o)"
      >
        <template #icon><HbIcon :name="(o.icon as IconName)" /></template>
        {{ o.arms && !o.armed ? `arm and ${o.label}` : o.label }}
      </HbButton>
    </div>

    <p v-for="m in missing" :key="m.label" class="bn-note" style="margin-top: 6px">
      to {{ m.label }}, connect {{ m.needs }}.
    </p>

    <p v-if="outcome" class="bn-note">{{ outcome }}</p>

    <div v-if="preview" class="bn-capcard">
      <div class="bn-subhead" style="margin-top: 0">this is what goes out</div>
      <div class="bn-io">{{ toHex(preview.bytes) || '(nothing to send)' }}</div>
      <div class="bn-acts" style="margin-top: 10px">
        <HbButton variant="danger" size="sm" @click="send">
          <template #icon><HbIcon name="tower-broadcast" /></template>
          send it
        </HbButton>
        <HbButton size="sm" @click="preview = null">cancel</HbButton>
      </div>
    </div>

    <ArmDialog
      v-if="arming"
      :device-id="arming.deviceId"
      :capability="arming.capability"
      @close="arming = null"
    />
  </div>
</template>

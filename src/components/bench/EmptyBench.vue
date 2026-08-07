<script setup lang="ts">
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { transportSupport } from '@/core/transport/support'
import { useConnectDialog } from '@/composables/useConnectDialog'

const connect = useConnectDialog()
const support = transportSupport()

const missing = Object.values(support).filter(
  (s) => !s.available && s.kind !== 'sim' && s.kind !== 'http',
)
</script>

<template>
  <div class="bn-empty">
    <h2>nothing on the bench yet</h2>
    <p>
      plug a radio, a board, or a probe into this machine and hit connect. the browser
      asks you which device to hand over, and it shows up in the rail on the left with
      only the tools it can actually run.
    </p>

    <div v-if="missing.length" class="bn-banner is-warn" style="text-align: left">
      <HbIcon name="warning" />
      <span>
        this browser is missing {{ missing.map((m) => m.kind).join(', ') }}.
        {{ missing[0].reason }}
      </span>
    </div>

    <div class="bn-acts">
      <HbButton variant="danger" @click="connect.open()">
        <template #icon><HbIcon name="plug-circle-plus" /></template>
        connect a device
      </HbButton>
    </div>
  </div>
</template>

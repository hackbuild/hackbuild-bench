<script setup lang="ts">
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'

function reload(): void {
  location.reload()
}
</script>

<template>
  <div class="bn-banner is-warn" role="alert">
    <HbIcon name="warning" />
    <span>
      this tool did not load. the bench was updated after this page opened, and the old
      copy of the tool is gone. reload to get the new one. a connected radio will need
      connecting again.
    </span>
    <HbButton size="sm" @click="reload">
      <template #icon><HbIcon name="repeat" /></template>
      reload
    </HbButton>
  </div>
</template>

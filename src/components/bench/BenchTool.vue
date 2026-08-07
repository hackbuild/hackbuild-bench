<script setup lang="ts">
import { HbIcon } from '@virgilvox/hackbuild-ui'
import type { IconName } from '@virgilvox/hackbuild-ui'
import type { ToolManifest } from '@/tools/types'

interface Props {
  tool: ToolManifest
}

defineProps<Props>()
</script>

<template>
  <section class="bn-plane">
    <div class="bn-planebar">
      <div class="bn-pt">
        <HbIcon :name="(tool.icon as IconName)" :size="16" />{{ tool.label }}
      </div>
      <span v-if="tool.blurb" class="bn-planedesc">{{ tool.blurb }}</span>
      <div class="bn-grow"></div>
    </div>
    <div class="bn-pcard">
      <component :is="tool.component" />
    </div>
  </section>
</template>

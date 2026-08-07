<script setup lang="ts">
import { computed } from 'vue'
import { HbIcon } from '@virgilvox/hackbuild-ui'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'
import { hasWebGPU } from '@/core/transport/support'

interface Props {
  focus: string
}

defineProps<Props>()

const devices = useDevices()
const bench = useBench()

const compute = computed(() => (hasWebGPU() ? 'webgpu' : 'wasm'))
const streaming = computed(() => devices.nodes.filter((n) => n.status === 'streaming').length)
</script>

<template>
  <footer class="bn-status">
    <span class="bn-cell">
      <HbIcon name="plug" :size="10" />devices <b>{{ devices.count }}</b>
    </span>
    <span class="bn-cell" v-if="streaming">streaming <b>{{ streaming }}</b></span>
    <span class="bn-cell">
      <HbIcon name="folder" :size="10" />project <span class="bn-tag">{{ bench.project }}</span>
    </span>
    <span class="bn-cell">focus <b>{{ focus }}</b></span>
    <span class="bn-cell">mode <b>{{ bench.mode }}</b></span>
    <span class="bn-cell">
      <HbIcon name="ear-listen" :size="10" />compute <b>{{ compute }}</b>
    </span>
    <span class="bn-cell bn-grow"></span>
    <span class="bn-cell">app.hack.build</span>
  </footer>
</template>

<script setup lang="ts">
import { computed } from 'vue'

interface PacketRow {
  id: string
  /** Bold identifier, grey descriptor, pink metric. */
  a: string
  b: string
  c: string
  /** Parsed payload, shown as a second line spanning the row. */
  decode?: string
  alert?: boolean
  badge?: string
}

interface Props {
  packets: PacketRow[]
  max?: number
  emptyText?: string
}

const props = withDefaults(defineProps<Props>(), {
  max: 200,
  emptyText: 'nothing yet',
})

// Row order is the caller's. This keeps the tail so a long capture does not
// grow the dom without bound.
const rows = computed(() => {
  const cap = Math.max(0, props.max)
  return props.packets.length > cap ? props.packets.slice(props.packets.length - cap) : props.packets
})
</script>

<template>
  <div class="bn-list">
    <div v-for="p in rows" :key="p.id" class="bn-row" :class="{ 'is-alert': p.alert }">
      <span class="bn-a">{{ p.a }}</span>
      <span class="bn-b">{{ p.b }}</span>
      <span class="bn-c">{{ p.c }}</span>
      <span v-if="p.badge" class="bn-trk">{{ p.badge }}</span>
      <span v-if="p.decode" class="bn-decode">{{ p.decode }}</span>
    </div>
    <div v-if="!rows.length" class="bn-row">
      <span class="bn-b">{{ emptyText }}</span>
    </div>
  </div>
</template>

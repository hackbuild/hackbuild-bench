<script setup lang="ts">
import { computed, ref } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { useSessionLog } from '@/stores/sessionLog'
import type { LogKind } from '@/stores/sessionLog'
import { formatClock } from '@/core/format'

const log = useSessionLog()

// 'note' is not filterable, so a note row falls back to its raw kind.
const KINDS: Array<{ id: LogKind; one: string; many: string }> = [
  { id: 'event', one: 'event', many: 'events' },
  { id: 'packet', one: 'packet', many: 'packets' },
  { id: 'line', one: 'serial', many: 'serial' },
  { id: 'transcript', one: 'speech', many: 'speech' },
  { id: 'reading', one: 'reading', many: 'readings' },
  { id: 'error', one: 'error', many: 'errors' },
]

const KIND_LABEL: Partial<Record<LogKind, string>> = Object.fromEntries(
  KINDS.map((k) => [k.id, k.one]),
)

const FILTERS: Array<{ id: LogKind | 'all'; label: string }> = [
  { id: 'all', label: 'all' },
  ...KINDS.map((k) => ({ id: k.id, label: k.many })),
]

const filter = ref<LogKind | 'all'>('all')

const shown = computed(() =>
  filter.value === 'all' ? log.entries : log.entries.filter((e) => e.kind === filter.value),
)

function kindColor(kind: LogKind): string {
  if (kind === 'error') return 'color: var(--hb-err)'
  if (kind === 'packet') return 'color: var(--hb-pink)'
  if (kind === 'transcript') return 'color: var(--hb-ok)'
  return ''
}

function exportLog(): void {
  const blob = new Blob([log.toText()], { type: 'text/plain' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'bench-session.log'
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div>
    <p class="bn-note" style="margin-top: 0">
      everything that happens on the bench lands here: devices connecting, calls and
      packets, decoded lines, spoken words picked up by transcription, and anything a rule
      writes. lifecycle events are always kept. the faster streams are kept only while you
      are recording.
    </p>

    <div class="bn-acts">
      <HbButton :variant="log.recording ? 'danger' : 'primary'" size="sm" @click="log.toggle()">
        <template #icon><HbIcon :name="log.recording ? 'stop' : 'record'" /></template>
        {{ log.recording ? 'stop recording' : 'record everything' }}
      </HbButton>
      <HbButton size="sm" :disabled="!log.count" @click="exportLog">
        <template #icon><HbIcon name="download" /></template>
        export
      </HbButton>
      <HbButton size="sm" :disabled="!log.count" @click="log.clear()">
        <template #icon><HbIcon name="trash" /></template>
        clear
      </HbButton>
      <span class="bn-chipx">{{ log.count }} entries</span>
    </div>

    <div class="bn-pills" style="margin-top: 12px">
      <button
        v-for="f in FILTERS"
        :key="f.id"
        type="button"
        class="bn-pill"
        :class="{ 'is-on': filter === f.id }"
        @click="filter = f.id"
      >
        {{ f.label }}
      </button>
    </div>

    <div class="bn-list" style="max-height: 60vh">
      <div v-for="e in shown.slice(0, 500)" :key="e.id" class="bn-row">
        <span class="bn-a" :style="kindColor(e.kind)">{{ e.message }}</span>
        <span class="bn-b">{{ KIND_LABEL[e.kind] ?? e.kind }}<template v-if="e.source"> · {{ e.source }}</template></span>
        <span class="bn-c">{{ formatClock(e.at) }}</span>
      </div>
      <div v-if="!shown.length" class="bn-row">
        <span class="bn-b">
          nothing logged yet. connect a device and it shows up here. press record to also
          capture the packets and lines that come in.
        </span>
      </div>
    </div>
  </div>
</template>

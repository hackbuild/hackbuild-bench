<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import LrptView from './LrptView.vue'
import AptArchive from './AptArchive.vue'
import type { DeviceToolProps } from '@/tools/types'

const props = defineProps<DeviceToolProps>()

const VIEWS = [
  { id: 'lrpt', label: 'meteor lrpt' },
  { id: 'apt', label: 'noaa apt archive' },
] as const
type View = (typeof VIEWS)[number]['id']

const view = ref<View>('lrpt')
const uid = useId()
const tabId = (v: View) => `${uid}-tab-${v}`
const panelId = (v: View) => `${uid}-panel-${v}`
const tabs = ref<HTMLButtonElement[]>([])

/** Arrow keys, home and end move between tabs and select the one they land on. */
async function onKey(ev: KeyboardEvent, i: number): Promise<void> {
  const n = VIEWS.length
  let next = -1
  if (ev.key === 'ArrowRight') next = (i + 1) % n
  else if (ev.key === 'ArrowLeft') next = (i - 1 + n) % n
  else if (ev.key === 'Home') next = 0
  else if (ev.key === 'End') next = n - 1
  if (next < 0) return
  ev.preventDefault()
  view.value = VIEWS[next].id
  await nextTick()
  tabs.value[next]?.focus()
}
</script>

<template>
  <div>
    <div class="bn-knobs">
      <div class="bn-seg2" role="tablist" aria-label="weather satellite decoder">
        <button
          v-for="(v, i) in VIEWS"
          :id="tabId(v.id)"
          :key="v.id"
          ref="tabs"
          type="button"
          role="tab"
          :aria-selected="view === v.id"
          :aria-controls="panelId(v.id)"
          :tabindex="view === v.id ? 0 : -1"
          :class="{ 'is-on': view === v.id }"
          @click="view = v.id"
          @keydown="onKey($event, i)"
        >
          {{ v.label }}
        </button>
      </div>
    </div>

    <div v-show="view === 'lrpt'" :id="panelId('lrpt')" role="tabpanel" :aria-labelledby="tabId('lrpt')">
      <LrptView :device-id="props.deviceId" />
    </div>
    <div v-if="view === 'apt'" :id="panelId('apt')" role="tabpanel" :aria-labelledby="tabId('apt')">
      <AptArchive />
    </div>
  </div>
</template>

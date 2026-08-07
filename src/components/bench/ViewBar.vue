<script setup lang="ts">
import { useBench } from '@/stores/bench'

interface Props {
  crumb: string
}

defineProps<Props>()

const bench = useBench()
</script>

<template>
  <div class="bn-viewbar">
    <div class="bn-vseg" role="group" aria-label="stage view">
      <button
        type="button"
        :class="{ 'is-on': bench.view === 'focus' }"
        :aria-pressed="bench.view === 'focus'"
        @click="bench.setView('focus')"
      >
        focus
      </button>
      <button
        type="button"
        :class="{ 'is-on': bench.view === 'rack' }"
        :aria-pressed="bench.view === 'rack'"
        @click="bench.setView('rack')"
      >
        rack
      </button>
    </div>
    <span class="bn-crumb">bench / <b>{{ crumb }}</b></span>
  </div>
</template>

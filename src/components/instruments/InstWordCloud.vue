<script setup lang="ts">
import { computed } from 'vue'

interface CloudWord {
  word: string
  count: number
  /** Where the word was last heard, in Hz. */
  hz?: number
}

interface Props {
  words: CloudWord[]
  max?: number
}

const props = withDefaults(defineProps<Props>(), { max: 90 })

const emit = defineEmits<{ (e: 'pick', hz: number): void }>()

/** Count descending, then alphabetical, so words that keep coming back walk
 * to the front on their own. Size stays constant, fill carries the emphasis. */
const shown = computed(() =>
  [...props.words]
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, Math.max(0, props.max)),
)

const repeated = computed(() => shown.value.filter((w) => w.count > 1).length)

const stat = computed(() =>
  props.words.length ? `${props.words.length} words, ${repeated.value} repeated` : 'nothing yet',
)

function tier(count: number): string {
  if (count >= 4) return 'is-hot'
  if (count >= 2) return 'is-rep'
  return ''
}

function title(w: CloudWord): string {
  if (w.hz === undefined || !Number.isFinite(w.hz)) return 'no frequency recorded'
  return `last heard near ${(w.hz / 1e6).toFixed(3)} MHz`
}

function pick(w: CloudWord): void {
  if (w.hz === undefined || !Number.isFinite(w.hz)) return
  emit('pick', w.hz)
}
</script>

<template>
  <div>
    <TransitionGroup tag="div" class="bn-wordcloud" name="bn-wordmove">
      <button
        v-for="w in shown"
        :key="w.word"
        type="button"
        class="bn-word"
        :class="tier(w.count)"
        :title="title(w)"
        @click="pick(w)"
      >
        {{ w.word }}<b v-if="w.count > 1">x{{ w.count }}</b>
      </button>
    </TransitionGroup>
    <div class="bn-note">{{ stat }}</div>
  </div>
</template>

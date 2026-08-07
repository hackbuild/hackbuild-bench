<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

interface TermLine {
  text: string
  stream: 'rx' | 'tx' | 'note'
  /** Wall clock ms. */
  at: number
}

interface Props {
  lines: TermLine[]
  prompt?: string
  placeholder?: string
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  prompt: '>',
  placeholder: 'type a command, enter to send',
  disabled: false,
})

const emit = defineEmits<{ (e: 'send', text: string): void }>()

const scrollback = ref<HTMLDivElement | null>(null)
const draft = ref('')
const history = ref<string[]>([])
const cursor = ref(-1)

function classFor(stream: TermLine['stream']): string {
  if (stream === 'tx') return 'is-tx'
  if (stream === 'note') return 'is-dim'
  return ''
}

function send(): void {
  const text = draft.value
  if (props.disabled || !text.trim()) return
  history.value.push(text)
  cursor.value = -1
  draft.value = ''
  emit('send', text)
}

/** ArrowUp walks back through what was sent, ArrowDown walks forward and
 * falls off the end into an empty line. */
function recall(step: number): void {
  if (!history.value.length) return
  const last = history.value.length - 1
  if (step < 0) {
    cursor.value = cursor.value === -1 ? last : Math.max(0, cursor.value - 1)
  } else if (cursor.value !== -1) {
    cursor.value = cursor.value + 1 > last ? -1 : cursor.value + 1
  }
  draft.value = cursor.value === -1 ? '' : history.value[cursor.value]
}

// Follow the tail only when the reader is already at the tail, so scrolling
// back to read something does not get yanked away by the next line.
watch(
  () => props.lines.length,
  async () => {
    const el = scrollback.value
    if (!el) return
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 8
    await nextTick()
    if (stuck) el.scrollTop = el.scrollHeight
  },
)
</script>

<template>
  <div>
    <div ref="scrollback" class="bn-term" role="log" aria-live="polite" aria-label="console output">
      <div
        v-for="(line, i) in lines"
        :key="line.at + '-' + i"
        :class="classFor(line.stream)"
      >
        {{ line.text }}
      </div>
    </div>
    <div class="bn-termin">
      <span aria-hidden="true">{{ prompt }}</span>
      <input
        v-model="draft"
        type="text"
        :placeholder="placeholder"
        :disabled="disabled"
        aria-label="console input"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter.prevent="send"
        @keydown.up.prevent="recall(-1)"
        @keydown.down.prevent="recall(1)"
      />
    </div>
  </div>
</template>

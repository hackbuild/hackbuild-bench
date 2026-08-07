<script setup lang="ts">
import { computed } from 'vue'
import { HbIcon } from '@virgilvox/hackbuild-ui'
import type { IconName } from '@virgilvox/hackbuild-ui'
import { CAPABILITY_LABELS, impactOf } from '@/core/capabilities'
import type { DeviceNode } from '@/core/types'
import { formatHz } from '@/core/format'

interface Props {
  node: DeviceNode
}

const props = defineProps<Props>()
const emit = defineEmits<{ pick: [id: string] }>()

/**
 * The headline readout is whichever parameter carries the most meaning for
 * this device, which in practice is its tuned frequency when it has one and
 * its first parameter otherwise.
 */
const headline = computed(() => {
  const params = props.node.descriptor.params
  const freq = params.find((p) => /hz$/i.test(p.key))
  const spec = freq ?? params[0]
  if (!spec) return null
  const value = props.node.params[spec.key] ?? spec.default
  if (freq) {
    const parts = formatHz(value).split(' ')
    return { value: parts[0], unit: parts[1] ?? '' }
  }
  return { value: String(value), unit: spec.unit ?? spec.label }
})

const status = computed(() => {
  if (props.node.status === 'error') return 'error'
  if (props.node.status === 'streaming') return 'streaming'
  return props.node.status
})

const chips = computed(() =>
  props.node.capabilities.slice(0, 4).map((c) => ({
    label: CAPABILITY_LABELS[c] ?? c,
    hot: impactOf(c) === 'consequential' && props.node.armed.includes(c),
  })),
)
</script>

<template>
  <button type="button" class="bn-face" @click="emit('pick', node.id)">
    <div class="bn-fh">
      <HbIcon :name="(node.descriptor.icon as IconName)" :size="12" />{{ node.label }}
      <span class="bn-st" :style="node.status === 'error' ? 'color:var(--hb-lit-warn)' : ''">
        {{ status }}
      </span>
    </div>
    <div class="bn-fb">
      <div v-if="headline" class="bn-big">
        {{ headline.value }}<small> {{ headline.unit }}</small>
      </div>
      <p
        v-if="node.error"
        style="font-family: var(--hb-body); font-size: 12px; color: var(--hb-ink-3); margin: 6px 0 0"
      >
        {{ node.error }}
      </p>
      <div v-if="chips.length" class="bn-fcaps">
        <span
          v-for="c in chips"
          :key="c.label"
          class="bn-chipx"
          :class="{ 'is-pink': c.hot }"
        >{{ c.label }}</span>
      </div>
    </div>
  </button>
</template>

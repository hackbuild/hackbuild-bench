<script setup lang="ts">
import { computed, useId } from 'vue'
import type { ParamSpec } from '@/core/types'

interface Props {
  spec: ParamSpec
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), { disabled: false })

const model = defineModel<number>({ required: true })

const id = useId()

/** Slider detents for the log control. The mapping needs a positive floor, so
 * a spec whose min is zero is treated as starting at one. */
const LOG_STEPS = 1000

const logMin = computed(() => Math.max(1, props.spec.min))
const logMax = computed(() => Math.max(logMin.value * 2, props.spec.max))

const logPos = computed(() => {
  const v = Math.max(logMin.value, Math.min(logMax.value, model.value))
  const ratio = Math.log(v / logMin.value) / Math.log(logMax.value / logMin.value)
  return Math.round(ratio * LOG_STEPS)
})

function fromLogPos(pos: number): number {
  return logMin.value * Math.pow(logMax.value / logMin.value, pos / LOG_STEPS)
}

const isFrequency = computed(() => (props.spec.unit ?? '').toLowerCase() === 'hz')

function format(value: number): string {
  if (!Number.isFinite(value)) return '--'
  if (isFrequency.value) return `${(value / 1e6).toFixed(3)} MHz`
  const step = props.spec.step ?? 1
  const places = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  const unit = props.spec.unit ? ` ${props.spec.unit}` : ''
  return `${value.toFixed(places)}${unit}`
}

const shown = computed(() => format(model.value))

function onRange(event: Event): void {
  const raw = Number((event.target as HTMLInputElement).value)
  model.value = props.spec.log ? fromLogPos(raw) : raw
}

function onSelect(event: Event): void {
  model.value = Number((event.target as HTMLSelectElement).value)
}
</script>

<template>
  <div class="bn-knob">
    <label class="bn-klabel" :for="id">
      {{ spec.label }}
      <b>{{ shown }}</b>
    </label>

    <select
      v-if="spec.choices && spec.choices.length"
      :id="id"
      :value="model"
      :disabled="disabled"
      @change="onSelect"
    >
      <option v-for="choice in spec.choices" :key="choice" :value="choice">
        {{ format(choice) }}
      </option>
    </select>

    <input
      v-else-if="spec.log"
      :id="id"
      type="range"
      min="0"
      :max="LOG_STEPS"
      step="1"
      :value="logPos"
      :disabled="disabled"
      :aria-valuetext="shown"
      @input="onRange"
    />

    <input
      v-else
      :id="id"
      type="range"
      :min="spec.min"
      :max="spec.max"
      :step="spec.step ?? 1"
      :value="model"
      :disabled="disabled"
      :aria-valuetext="shown"
      @input="onRange"
    />
  </div>
</template>

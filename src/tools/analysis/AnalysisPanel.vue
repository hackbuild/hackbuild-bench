<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { OPERATIONS, bake } from '@/core/analysis/recipe'
import { magic } from '@/core/analysis/magic'
import { shannonEntropy, printableRatio } from '@/core/analysis/metrics'
import { useBench } from '@/stores/bench'
import { fromHex, toAscii, toHex } from '@/core/format'

const bench = useBench()

interface Step {
  opId: string
  args: Record<string, unknown>
}

const rawInput = ref('ed e4 fc e7 f5 fd 85 d1 cb c0 cb d1 d7 85 c6 c0 d7 c3 c3 85 90 90 93 93')
const steps = ref<Step[]>([])
const intensive = ref(false)

const input = computed(() => {
  const text = rawInput.value.trim()
  // a run of hex pairs is almost always meant as bytes, anything else as text.
  return /^[0-9a-f\s]+$/i.test(text) && text.replace(/\s/g, '').length % 2 === 0
    ? fromHex(text)
    : new TextEncoder().encode(text)
})

const result = computed(() => bake(input.value, steps.value))
const output = computed(() => result.value.output)

const hits = computed(() => magic(output.value, { intensive: intensive.value }))

const entropy = computed(() => shannonEntropy(output.value).toFixed(2))
const printable = computed(() => `${Math.round(printableRatio(output.value) * 100)}%`)

watch(
  () => bench.analysisInput,
  (v) => {
    if (v) {
      rawInput.value = toHex(v.bytes)
      steps.value = []
    }
  },
  { deep: true },
)

function addStep(opId: string, args: Record<string, unknown> = {}): void {
  const op = OPERATIONS.find((o) => o.id === opId)
  if (!op) return
  const filled = { ...Object.fromEntries(op.args.map((a) => [a.key, a.default])), ...args }
  steps.value = [...steps.value, { opId, args: filled }]
}

function removeStep(i: number): void {
  steps.value = steps.value.filter((_, idx) => idx !== i)
}

function label(opId: string): string {
  return OPERATIONS.find((o) => o.id === opId)?.label ?? opId
}

function argText(s: Step): string {
  const values = Object.values(s.args).filter((v) => v !== '' && v !== undefined)
  return values.map((v) => String(v)).join(' ')
}
</script>

<template>
  <div class="bn-grid2">
    <div>
      <div class="bn-subhead">
        input
        <span v-if="bench.analysisInput" class="bn-aside">
          from {{ bench.analysisInput.label }}
        </span>
      </div>
      <textarea
        v-model="rawInput"
        rows="3"
        style="
          width: 100%;
          font-family: var(--hb-readout);
          font-size: 15px;
          border: 2px solid var(--hb-ink);
          background: var(--hb-paper-raised);
          padding: 8px;
        "
      ></textarea>

      <div class="bn-subhead" style="margin-top: 12px">
        recipe
        <span class="bn-grow"></span>
        <select
          style="font-family: var(--hb-utility); font-size: 10px; border: 2px solid var(--hb-ink); padding: 2px"
          @change="addStep(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''"
        >
          <option value="">add an operation</option>
          <option v-for="o in OPERATIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
        </select>
      </div>

      <div v-if="steps.length">
        <div v-for="(s, i) in steps" :key="i" class="bn-op">
          <span class="bn-n">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="bn-t">{{ label(s.opId) }}</span>
          <span class="bn-a">{{ argText(s) }}</span>
          <button type="button" class="bn-tinyact" @click="removeStep(i)">drop</button>
        </div>
      </div>
      <p v-else class="bn-note" style="margin-top: 0">
        nothing in the chain yet. add an operation, or take one of the guesses on the
        right.
      </p>

      <div class="bn-subhead" style="margin-top: 12px">output</div>
      <div class="bn-io">{{ toAscii(output) || '(empty)' }}</div>
      <p v-if="result.error" class="bn-note" style="color: var(--hb-err)">
        {{ result.error }}
      </p>

      <div class="bn-reads">
        <div class="bn-read">
          <div class="bn-k">entropy</div>
          <div class="bn-v">{{ entropy }}</div>
        </div>
        <div class="bn-read">
          <div class="bn-k">printable</div>
          <div class="bn-v">{{ printable }}</div>
        </div>
        <div class="bn-read">
          <div class="bn-k">bytes</div>
          <div class="bn-v">{{ output.length }}</div>
        </div>
      </div>
    </div>

    <div>
      <div class="bn-magic">
        <div class="bn-mh">
          <HbIcon name="wand" :size="16" />
          {{ hits.length ? 'magic found something' : 'magic found nothing yet' }}
        </div>
        <div class="bn-mb">
          <div v-for="h in hits" :key="h.opId + JSON.stringify(h.args)" class="bn-hit">
            <span class="bn-name">{{ h.label }}</span>
            <span class="bn-bw">
              <span class="bn-bar" :style="{ width: `${Math.round(h.confidence * 100)}%` }"></span>
            </span>
            <span class="bn-pct">{{ Math.round(h.confidence * 100) }}%</span>
            <button type="button" class="bn-tinyact" @click="addStep(h.opId, h.args)">add</button>
          </div>

          <p v-if="!hits.length" class="bn-note" style="margin-top: 0">
            nothing scored above the noise. try intensive, which brute forces single byte
            xor, bit rotations, and caesar shifts.
          </p>

          <div class="bn-acts" style="margin-top: 10px">
            <HbButton size="sm" @click="intensive = !intensive">
              {{ intensive ? 'intensive on' : 'try intensive' }}
            </HbButton>
          </div>
        </div>
      </div>

      <p class="bn-note">
        every guess is scored by what it does to the data: entropy dropping, printable
        characters rising, and words that look like english appearing. add one and magic
        runs again on the result, so nested layers peel one at a time.
      </p>
    </div>
  </div>
</template>

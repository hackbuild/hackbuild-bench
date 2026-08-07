<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { OPERATIONS, bake, makeStep } from '@/core/analysis/recipe'
import type { RecipeStep } from '@/core/analysis/recipe'
import { magic, solve } from '@/core/analysis/magic'
import { printableRatio, shannonEntropy } from '@/core/analysis/metrics'
import { useBench } from '@/stores/bench'
import { fromHex, toAscii, toHex } from '@/core/format'

const bench = useBench()

type InputMode = 'auto' | 'hex' | 'text'

const MODES: Array<{ id: InputMode; label: string }> = [
  { id: 'auto', label: 'auto' },
  { id: 'hex', label: 'hex bytes' },
  { id: 'text', label: 'text' },
]

/** rot13 over the plaintext, then xor a5, so one press has two layers to peel. */
const EXAMPLE = 'ed e4 fc e7 f5 fd 85 d1 cb c0 cb d1 d7 85 c6 c0 d7 c3 c3 85 90 90 93 93'

const rawInput = ref(EXAMPLE)
const mode = ref<InputMode>('auto')
const steps = ref<RecipeStep[]>([])
const intensive = ref(false)
const report = ref<{ ok: boolean; text: string } | null>(null)

const hexDigits = computed(() => rawInput.value.replace(/[^0-9a-f]/gi, '').length)

const detected = computed<'hex' | 'text'>(() => {
  const text = rawInput.value.trim()
  // a run of hex pairs is almost always meant as bytes, anything else as text.
  return /^[0-9a-f\s,:]+$/i.test(text) && hexDigits.value >= 2 && hexDigits.value % 2 === 0
    ? 'hex'
    : 'text'
})

const kind = computed<'hex' | 'text'>(() => (mode.value === 'auto' ? detected.value : mode.value))
const oddHex = computed(() => kind.value === 'hex' && hexDigits.value % 2 === 1)

const input = computed(() =>
  kind.value === 'hex' ? fromHex(rawInput.value) : new TextEncoder().encode(rawInput.value),
)

const result = computed(() => bake(input.value, steps.value))
const output = computed(() => result.value.output)

const hits = computed(() => magic(output.value, { intensive: intensive.value }))

const entropy = computed(() => shannonEntropy(output.value).toFixed(2))
const printable = computed(() => `${Math.round(printableRatio(output.value) * 100)}%`)
const hexPreview = computed(() => {
  const head = input.value.subarray(0, 12)
  return toHex(head) + (input.value.length > head.length ? ' ...' : '')
})

watch(
  () => bench.analysisInput,
  (v) => {
    if (v) {
      rawInput.value = toHex(v.bytes)
      mode.value = 'hex'
      steps.value = []
      report.value = null
    }
  },
  { deep: true },
)

function loadExample(): void {
  rawInput.value = EXAMPLE
  mode.value = 'auto'
  steps.value = []
  report.value = null
}

function addStep(opId: string, args: Record<string, unknown> = {}): void {
  if (!OPERATIONS.some((o) => o.id === opId)) return
  steps.value = [...steps.value, makeStep(opId, args)]
  report.value = null
}

function applyChain(chain: RecipeStep[]): void {
  steps.value = [...steps.value, ...chain]
  report.value = null
}

function figureItOut(): void {
  const found = solve(output.value, { maxDepth: 3 })
  if (!found) {
    report.value = {
      ok: false,
      text: 'nothing read better than what you already have. turn intensive on, or add an operation by hand.',
    }
    return
  }
  steps.value = [...steps.value, ...found.steps]
  report.value = { ok: true, text: `applied ${found.sentence}` }
}

function removeStep(i: number): void {
  steps.value = steps.value.filter((_, idx) => idx !== i)
  report.value = null
}

function moveStep(i: number, delta: number): void {
  const to = i + delta
  if (to < 0 || to >= steps.value.length) return
  const next = [...steps.value]
  const [moved] = next.splice(i, 1)
  next.splice(to, 0, moved)
  steps.value = next
  report.value = null
}

function label(opId: string): string {
  return OPERATIONS.find((o) => o.id === opId)?.label ?? opId
}

function argText(s: RecipeStep): string {
  const values = Object.values(s.args).filter((v) => v !== '' && v !== undefined)
  return values.map((v) => String(v)).join(' ')
}

function short(bytes: Uint8Array, n = 64): string {
  const text = toAscii(bytes)
  return text.length > n ? `${text.slice(0, n)}...` : text
}

function stepText(i: number): string {
  const perStep = result.value.perStep
  if (i >= perStep.length) return 'stopped here'
  return short(perStep[i]) || '(empty)'
}

function stepFailed(i: number): boolean {
  return i >= result.value.perStep.length
}

function onPick(event: Event): void {
  const select = event.target as HTMLSelectElement
  if (select.value) addStep(select.value)
  select.value = ''
}
</script>

<template>
  <div>
    <div class="bn-leadrow">
      <p class="bn-lead">
        a recipe is a chain of operations run over your bytes in order, top to bottom. magic
        tries thousands of chains for you and ranks the ones that turn the bytes into
        something you can read.
      </p>
      <HbButton size="sm" variant="secondary" @click="loadExample">
        <template #icon><HbIcon name="flask" /></template>
        try an example
      </HbButton>
    </div>

    <div class="bn-grid2">
      <div>
        <div class="bn-subhead">
          input
          <span v-if="bench.analysisInput" class="bn-aside">
            from {{ bench.analysisInput.label }}
          </span>
          <span class="bn-grow"></span>
          <span class="bn-seg2" role="group" aria-label="how to read the input">
            <button
              v-for="m in MODES"
              :key="m.id"
              type="button"
              :class="{ 'is-on': mode === m.id }"
              :aria-pressed="mode === m.id"
              @click="mode = m.id"
            >
              {{ m.label }}
            </button>
          </span>
        </div>

        <textarea
          v-model="rawInput"
          class="bn-ta"
          rows="3"
          aria-label="bytes to work on"
        ></textarea>

        <div class="bn-inmeta">
          <span class="bn-k">
            read as {{ kind === 'hex' ? 'hex bytes' : 'text' }}{{ mode === 'auto' ? ', detected' : ', your choice' }}
          </span>
          <span class="bn-k">{{ input.length }} bytes</span>
          <span class="bn-hexp">{{ hexPreview || '(nothing yet)' }}</span>
        </div>
        <p v-if="oddHex" class="bn-note" style="color: var(--hb-warn)">
          odd number of hex digits, the last one is dropped.
        </p>

        <div class="bn-subhead" style="margin-top: 12px">
          recipe
          <span class="bn-grow"></span>
          <select aria-label="add an operation to the recipe" @change="onPick">
            <option value="">add an operation</option>
            <option v-for="o in OPERATIONS" :key="o.id" :value="o.id">{{ o.label }}</option>
          </select>
        </div>

        <div v-if="steps.length">
          <div v-for="(s, i) in steps" :key="i" class="bn-op">
            <span class="bn-n">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="bn-t">{{ label(s.opId) }}</span>
            <span class="bn-a">{{ argText(s) }}</span>
            <span class="bn-btns">
              <button
                type="button"
                class="bn-tinyact"
                :disabled="i === 0"
                :aria-label="`move step ${i + 1} up`"
                @click="moveStep(i, -1)"
              >
                up
              </button>
              <button
                type="button"
                class="bn-tinyact"
                :disabled="i === steps.length - 1"
                :aria-label="`move step ${i + 1} down`"
                @click="moveStep(i, 1)"
              >
                down
              </button>
              <button
                type="button"
                class="bn-tinyact"
                :aria-label="`drop step ${i + 1}`"
                @click="removeStep(i)"
              >
                drop
              </button>
            </span>
            <span class="bn-out" :class="{ 'is-err': stepFailed(i) }">{{ stepText(i) }}</span>
          </div>
        </div>
        <p v-else class="bn-note" style="margin-top: 0">
          nothing in the chain yet. press figure it out, take a candidate, or add an
          operation by hand.
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
            magic
          </div>
          <div class="bn-mb">
            <HbButton block @click="figureItOut">
              <template #icon><HbIcon name="bolt" /></template>
              figure it out
            </HbButton>
            <p class="bn-mnote">
              one press runs the intensive search, applies the best chain up to three layers
              deep, and stops when the output stops improving.
            </p>

            <div v-if="report" class="bn-solved" :class="{ 'is-miss': !report.ok }" role="status">
              {{ report.text }}
            </div>

            <div class="bn-subhead" style="margin-top: 14px">
              candidates
              <span class="bn-grow"></span>
              <button
                type="button"
                class="bn-tinyact"
                :aria-pressed="intensive"
                @click="intensive = !intensive"
              >
                intensive {{ intensive ? 'on' : 'off' }}
              </button>
            </div>

            <div v-for="(h, i) in hits" :key="`${i}:${h.chainLabel}`" class="bn-hit">
              <div class="bn-htop">
                <span class="bn-name">{{ h.chainLabel }}</span>
                <span class="bn-bw">
                  <span
                    class="bn-bar"
                    :style="{ width: `${Math.round(h.confidence * 100)}%` }"
                  ></span>
                </span>
                <span class="bn-pct">{{ Math.round(h.confidence * 100) }}%</span>
                <button
                  type="button"
                  class="bn-tinyact"
                  :aria-label="`apply ${h.chainLabel}`"
                  @click="applyChain(h.chain)"
                >
                  apply
                </button>
              </div>
              <div class="bn-why">
                <span v-for="sig in h.signals.slice(0, 3)" :key="sig.id" class="bn-chipx">
                  {{ sig.label }}
                </span>
              </div>
              <div class="bn-prev">{{ h.preview }}</div>
            </div>

            <p v-if="!hits.length" class="bn-note" style="margin-top: 0">
              nothing scored above the noise. turn intensive on to brute force single byte
              xor, bit rotations, and caesar shifts.
            </p>
          </div>
        </div>

        <p class="bn-note">
          each candidate is scored on what it does to the bytes: printable characters rising,
          entropy dropping, known words appearing. apply one and magic runs again on the
          result, so nested layers peel one at a time.
        </p>
      </div>
    </div>
  </div>
</template>

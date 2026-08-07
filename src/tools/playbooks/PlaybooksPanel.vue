<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import type { IconName } from '@virgilvox/hackbuild-ui'
import ArmDialog from '@/components/bench/ArmDialog.vue'
import InstHexView from '@/components/instruments/InstHexView.vue'
import { bus } from '@/core/bus/DeviceBus'
import { CAPABILITY_LABELS } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import { formatClock } from '@/core/format'
import { PLAYBOOKS } from '@/core/playbooks/library'
import { needsText } from '@/core/playbooks/runner'
import type { StepStatus } from '@/core/playbooks/runner'
import type { Playbook, PlaybookStep } from '@/core/playbooks/types'
import { playbookRunner } from './session'
import { useDevices } from '@/stores/devices'

const devices = useDevices()

const runner = playbookRunner()

// the runner holds no vue, so a version counter turns its change events into
// a render.
const version = ref(0)
const stopWatching = runner.onChange(() => {
  version.value++
})

const armPending = ref<{ deviceId: string; capability: Capability } | null>(null)

onBeforeUnmount(stopWatching)

interface Card {
  pb: Playbook
  ready: boolean
  reason: string
}

const cards = computed<Card[]>(() => {
  void devices.nodes
  return PLAYBOOKS.map((pb) => {
    const missing = pb.requires.filter((c) => devices.providers(c).length === 0)
    const any = pb.requiresAny ?? []
    if (any.length && any.every((c) => devices.providers(c).length === 0)) missing.push(any[0])
    return {
      pb,
      ready: missing.length === 0,
      reason: missing.map((c) => needsText(c, bus)).join(', and it '),
    }
  })
})

const active = computed<Playbook | null>(() => {
  void version.value
  return runner.playbook
})

const statuses = computed<StepStatus[]>(() => {
  void version.value
  void devices.nodes
  return runner.statuses
})

const busy = computed(() => {
  void version.value
  return runner.busy
})

const error = computed(() => {
  void version.value
  return runner.error
})

const lines = computed(() => {
  void version.value
  return runner.lines
})

const logPane = ref<HTMLElement | null>(null)

watch(
  () => lines.value.length,
  () => {
    void nextTick(() => {
      if (logPane.value) logPane.value.scrollTop = logPane.value.scrollHeight
    })
  },
)

const finished = computed(() => {
  void version.value
  void devices.nodes
  return runner.finished
})

const settled = computed(() => {
  void version.value
  void devices.nodes
  return runner.settled
})

const blockedText = computed(() =>
  runner.blocked.map((s) => `${s.step.title} ${s.readiness.reason}`).join('. '),
)

function open(pb: Playbook): void {
  runner.start(pb)
}

function choicesFor(step: PlaybookStep) {
  void version.value
  return runner.choicesFor(step)
}

function chosen(step: PlaybookStep): string | number | undefined {
  void version.value
  return runner.chosen(step)
}

function choiceHint(step: PlaybookStep): string {
  const pick = choicesFor(step).find((c) => c.value === chosen(step))
  return pick?.hint ?? ''
}

function summaryFor(step: PlaybookStep): string[] {
  void version.value
  return runner.summaryFor(step)
}

function hasBytes(step: PlaybookStep): boolean {
  return (runner.bytesFor(step)?.length ?? 0) > 0
}

function bytesOf(step: PlaybookStep): Uint8Array {
  return runner.bytesFor(step) ?? new Uint8Array(0)
}

function capLabel(cap: Capability): string {
  return CAPABILITY_LABELS[cap] ?? cap
}

function armStep(s: StepStatus): void {
  if (!s.step.arms || !s.armNode) return
  armPending.value = { deviceId: s.armNode.id, capability: s.step.arms }
}

function stepDisabled(s: StepStatus): boolean {
  if (busy.value || !s.readiness.ready) return true
  return !!s.step.arms && !s.armed
}
</script>

<template>
  <div>
    <template v-if="!active">
      <div class="bn-subhead">
        playbooks
        <span class="bn-aside">the bench does the work, you press through it</span>
      </div>

      <div class="bn-rack">
        <button
          v-for="c in cards"
          :key="c.pb.id"
          type="button"
          class="bn-face"
          @click="open(c.pb)"
        >
          <div class="bn-fh">
            <HbIcon :name="(c.pb.icon as IconName)" :size="12" />
            {{ c.pb.title }}
            <span class="bn-st">{{ c.pb.steps.length }} steps</span>
          </div>
          <div class="bn-fb">
            <p class="bn-note" style="margin-top: 0">{{ c.pb.blurb }}</p>
            <div class="bn-fcaps">
              <span class="bn-chipx" :class="{ 'is-pink': c.ready }">
                {{ c.ready ? 'ready' : c.reason }}
              </span>
            </div>
          </div>
        </button>
      </div>

      <p class="bn-note">
        a playbook asks the bench for capabilities, not for devices. one radio can do the
        listening while another does the sending, and a board can move a pin at the end of
        it.
      </p>
    </template>

    <template v-else>
      <div class="bn-subhead">
        {{ active.title }}
        <span class="bn-aside">{{ active.blurb }}</span>
        <span class="bn-grow"></span>
        <HbButton size="sm" @click="runner.abort()">
          <template #icon><HbIcon name="stop" /></template>
          stop
        </HbButton>
      </div>

      <div v-if="error" class="bn-banner is-err">
        <HbIcon name="warning" :size="14" />
        {{ error }}
      </div>
      <div v-else-if="finished" class="bn-banner">
        <HbIcon name="check" :size="14" />
        every step is done.
      </div>
      <div v-else-if="settled" class="bn-banner is-warn">
        <HbIcon name="plug-circle-plus" :size="14" />
        everything the bench can reach is done. {{ blockedText }}.
      </div>

      <ol style="list-style: none; margin: 0; padding: 0">
        <li
          v-for="s in statuses"
          :key="s.step.id"
          :style="{ opacity: s.current || s.complete ? 1 : 0.5 }"
        >
          <div class="bn-op">
            <span class="bn-n">{{ String(s.index + 1).padStart(2, '0') }}</span>
            <span class="bn-t">{{ s.step.title }}</span>
            <HbIcon v-if="s.complete" name="check" :size="12" />
            <span v-else-if="!s.readiness.ready" class="bn-chipx">blocked</span>
            <span v-else-if="s.current" class="bn-chipx is-pink">now</span>
            <span v-else-if="s.step.manual" class="bn-chipx">your turn</span>
          </div>

          <div
            v-if="s.complete && !s.current && summaryFor(s.step).length"
            class="bn-op"
            style="align-items: flex-start"
          >
            <span class="bn-n"></span>
            <span class="bn-t" style="font-weight: 400; color: var(--hb-ink-3)">
              <span
                v-for="(line, i) in summaryFor(s.step)"
                :key="i"
                style="display: block"
              >{{ line }}</span>
            </span>
          </div>

          <div v-if="s.current" class="bn-capcard">
            <p class="bn-note" style="margin-top: 0">{{ s.step.detail }}</p>

            <div v-if="!s.readiness.ready" class="bn-banner is-warn">
              <HbIcon name="plug-circle-plus" :size="14" />
              this step {{ s.readiness.reason }}
            </div>

            <div v-if="choicesFor(s.step).length" class="bn-pills">
              <button
                v-for="c in choicesFor(s.step)"
                :key="String(c.value)"
                type="button"
                class="bn-pill"
                :class="{ 'is-on': chosen(s.step) === c.value }"
                :aria-pressed="chosen(s.step) === c.value"
                @click="runner.choose(s.step, c.value)"
              >
                {{ c.label }}
              </button>
            </div>
            <p v-if="choiceHint(s.step)" class="bn-note" style="margin: 0 0 10px">
              {{ choiceHint(s.step) }}
            </p>

            <div class="bn-acts">
              <HbButton
                v-if="s.step.arms && !s.armed"
                variant="danger"
                size="sm"
                :disabled="!s.armNode"
                @click="armStep(s)"
              >
                <template #icon><HbIcon name="bolt" /></template>
                arm {{ capLabel(s.step.arms) }}
                <template v-if="s.armNode"> on {{ s.armNode.label }}</template>
              </HbButton>
              <span v-else-if="s.step.arms" class="bn-chipx is-pink">
                {{ capLabel(s.step.arms) }} armed on {{ s.armNode?.label }}
              </span>

              <HbButton
                v-if="s.step.run"
                size="sm"
                :disabled="stepDisabled(s)"
                :loading="busy"
                @click="runner.runCurrent()"
              >
                <template #icon><HbIcon name="play" /></template>
                {{ busy ? 'working' : (s.step.actionLabel ?? 'do it') }}
              </HbButton>
              <span v-else-if="!s.step.arms" class="bn-chipx">
                this one ticks itself when the bench is ready
              </span>
            </div>

            <div v-if="summaryFor(s.step).length" style="margin-top: 12px">
              <div class="bn-subhead">what it found</div>
              <div v-for="(line, i) in summaryFor(s.step)" :key="i" class="bn-op">
                <span class="bn-t">{{ line }}</span>
              </div>
            </div>

            <div v-if="hasBytes(s.step)" style="margin-top: 12px">
              <div class="bn-subhead">
                bytes
                <span class="bn-aside">exactly what goes out</span>
              </div>
              <InstHexView :bytes="bytesOf(s.step)" />
            </div>
          </div>
        </li>
      </ol>

      <div class="bn-subhead" style="margin-top: 14px">log</div>
      <div ref="logPane" class="bn-term" style="height: 170px">
        <div v-for="(l, i) in lines" :key="i">
          <span class="is-dim">{{ formatClock(l.at) }}</span>
          {{ ' ' + l.text }}
        </div>
        <div v-if="!lines.length" class="is-dim">nothing yet</div>
      </div>
    </template>

    <ArmDialog
      v-if="armPending"
      :device-id="armPending.deviceId"
      :capability="armPending.capability"
      @close="armPending = null"
    />
  </div>
</template>

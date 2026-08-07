<script setup lang="ts">
import { computed } from 'vue'
import { HbButton, HbIcon } from '@virgilvox/hackbuild-ui'
import { useAutomations } from '@/stores/automations'
import type { Rule } from '@/stores/automations'
import { useDevices } from '@/stores/devices'
import { CAPABILITIES } from '@/core/capabilities'
import { ACTION_LABELS, TRIGGER_LABELS } from '@/core/automations/actions'
import type { ActionType, TriggerType } from '@/core/automations/actions'
import { formatClock } from '@/core/format'

const rules = useAutomations()
const devices = useDevices()

const sources = computed(() => devices.nodes.map((n) => ({ id: n.id, label: n.label })))
const pinDevices = computed(() =>
  devices.nodes.filter((n) => n.capabilities.includes(CAPABILITIES.GPIO_DRIVE)),
)
const radioDevices = computed(() =>
  devices.nodes.filter((n) => n.capabilities.includes(CAPABILITIES.AUDIO_DEMOD)),
)

const TRIGGERS: TriggerType[] = ['any', 'packet', 'line', 'transcript', 'reading']
const ACTIONS: ActionType[] = ['log', 'notify', 'record', 'pin', 'retune']

function needsMatch(t: TriggerType): boolean {
  return t === 'packet' || t === 'line' || t === 'transcript'
}

function setTrigger(rule: Rule, patch: Partial<Rule['trigger']>): void {
  rules.update(rule.id, { trigger: { ...rule.trigger, ...patch } })
}
function setCondition(rule: Rule, patch: Partial<Rule['condition']>): void {
  rules.update(rule.id, { condition: { ...rule.condition, ...patch } })
}
function setAction(rule: Rule, patch: Partial<Rule['action']>): void {
  rules.update(rule.id, { action: { ...rule.action, ...patch } })
}

function actionReady(rule: Rule): string | null {
  const a = rule.action
  if (a.type === 'pin') {
    if (a.deviceId === undefined) return 'pick a board'
    const node = devices.nodes.find((n) => n.id === a.deviceId)
    if (!node) return 'the board is gone'
    if (!node.armed.includes(CAPABILITIES.GPIO_DRIVE)) return `arm gpio drive on ${node.label}`
  }
  if (a.type === 'retune' && a.deviceId === undefined) return 'pick a radio'
  return null
}
</script>

<template>
  <div>
    <div class="bn-subhead">
      rules
      <span class="bn-aside">a rule watches the bus and runs a real action when it matches</span>
      <span class="bn-grow"></span>
      <HbButton variant="danger" size="sm" :disabled="!sources.length" @click="rules.addBlank()">
        <template #icon><HbIcon name="plus" /></template>
        new rule
      </HbButton>
    </div>

    <p v-if="!sources.length" class="bn-note" style="margin-top: 0">
      connect something first, or turn on demo mode. a rule needs a device to watch.
    </p>

    <div v-for="rule in rules.rules" :key="rule.id" class="bn-rulecard">
      <div class="bn-flow">
        <div class="bn-node is-trigger">
          <div class="bn-nh"><HbIcon name="bolt" :size="9" />when</div>
          <div class="bn-nb">
            <select
              :value="rule.trigger.type"
              @change="setTrigger(rule, { type: ($event.target as HTMLSelectElement).value as TriggerType })"
            >
              <option v-for="t in TRIGGERS" :key="t" :value="t">{{ TRIGGER_LABELS[t] }}</option>
            </select>
            <select
              :value="rule.trigger.deviceId ?? ''"
              @change="setTrigger(rule, { deviceId: ($event.target as HTMLSelectElement).value || undefined })"
            >
              <option value="">on any device</option>
              <option v-for="s in sources" :key="s.id" :value="s.id">on {{ s.label }}</option>
            </select>
            <input
              v-if="needsMatch(rule.trigger.type)"
              type="text"
              :value="rule.trigger.match ?? ''"
              placeholder="text to match"
              @input="setTrigger(rule, { match: ($event.target as HTMLInputElement).value })"
            />
          </div>
        </div>

        <div class="bn-arrow"><HbIcon name="arrow-right" :size="22" /></div>

        <div class="bn-node is-condition">
          <div class="bn-nh"><HbIcon name="filter" :size="9" />if</div>
          <div class="bn-nb">
            <label class="bn-klabel">rate limit</label>
            <select
              :value="rule.condition.minGapMs"
              @change="setCondition(rule, { minGapMs: Number(($event.target as HTMLSelectElement).value) })"
            >
              <option :value="0">no limit</option>
              <option :value="1000">once a second</option>
              <option :value="2000">once every 2 s</option>
              <option :value="10000">once every 10 s</option>
              <option :value="60000">once a minute</option>
            </select>
          </div>
        </div>

        <div class="bn-arrow"><HbIcon name="arrow-right" :size="22" /></div>

        <div class="bn-node is-action">
          <div class="bn-nh"><HbIcon name="play" :size="9" />do</div>
          <div class="bn-nb">
            <select
              :value="rule.action.type"
              @change="setAction(rule, { type: ($event.target as HTMLSelectElement).value as ActionType })"
            >
              <option v-for="a in ACTIONS" :key="a" :value="a">{{ ACTION_LABELS[a] }}</option>
            </select>

            <template v-if="rule.action.type === 'pin'">
              <select
                :value="rule.action.deviceId ?? ''"
                @change="setAction(rule, { deviceId: ($event.target as HTMLSelectElement).value || undefined })"
              >
                <option value="">pick a board</option>
                <option v-for="d in pinDevices" :key="d.id" :value="d.id">{{ d.label }}</option>
              </select>
              <input
                type="number"
                :value="rule.action.pin ?? 2"
                placeholder="pin"
                @input="setAction(rule, { pin: Number(($event.target as HTMLInputElement).value) })"
              />
              <select
                :value="rule.action.pinMode ?? 'pulse'"
                @change="setAction(rule, { pinMode: ($event.target as HTMLSelectElement).value as 'high' | 'low' | 'pulse' })"
              >
                <option value="pulse">pulse</option>
                <option value="high">set high</option>
                <option value="low">set low</option>
              </select>
            </template>

            <template v-else-if="rule.action.type === 'retune'">
              <select
                :value="rule.action.deviceId ?? ''"
                @change="setAction(rule, { deviceId: ($event.target as HTMLSelectElement).value || undefined })"
              >
                <option value="">pick a radio</option>
                <option v-for="d in radioDevices" :key="d.id" :value="d.id">{{ d.label }}</option>
              </select>
              <input
                type="number"
                :value="rule.action.hz ? rule.action.hz / 1e6 : 100.3"
                step="0.001"
                placeholder="MHz"
                @input="setAction(rule, { hz: Number(($event.target as HTMLInputElement).value) * 1e6 })"
              />
            </template>

            <input
              v-else-if="rule.action.type === 'log' || rule.action.type === 'notify'"
              type="text"
              :value="rule.action.message ?? ''"
              placeholder="message, or leave blank to quote the trigger"
              @input="setAction(rule, { message: ($event.target as HTMLInputElement).value })"
            />
          </div>
        </div>
      </div>

      <div class="bn-acts" style="margin-top: 8px">
        <button
          type="button"
          class="bn-toggle"
          :class="{ 'is-on': rule.enabled }"
          @click="rules.toggle(rule.id)"
        >
          <span class="bn-sw"><i></i></span>{{ rule.enabled ? 'armed' : 'off' }}
        </button>
        <span class="bn-chipx">fired {{ rule.fired }}</span>
        <button type="button" class="bn-tinyact" @click="rules.test(rule.id)">test now</button>
        <span v-if="actionReady(rule)" class="bn-chipx" style="border-color: var(--hb-warn); color: var(--hb-warn)">
          {{ actionReady(rule) }}
        </span>
        <span v-if="rule.lastError" class="bn-trk">{{ rule.lastError }}</span>
        <button type="button" class="bn-tinyact" @click="rules.remove(rule.id)">delete</button>
      </div>
    </div>

    <p v-if="!rules.rules.length && sources.length" class="bn-note" style="margin-top: 0">
      nothing wired up yet. a rule watches one device stream and runs an action, so a frame
      seen on a radio can pulse a pin on a board, a spoken word can start a recording, or a
      matched serial line can notify you. build one, press test now to see it work, then arm it.
    </p>

    <div v-if="rules.log.length" class="bn-subhead" style="margin-top: 16px">what fired</div>
    <div v-if="rules.log.length" class="bn-list">
      <div v-for="(e, i) in rules.log.slice(0, 40)" :key="i" class="bn-row">
        <span class="bn-a" :style="e.level === 'error' ? 'color: var(--hb-err)' : ''">{{ e.message }}</span>
        <span class="bn-b"></span>
        <span class="bn-c">{{ formatClock(e.at) }}</span>
      </div>
    </div>
  </div>
</template>

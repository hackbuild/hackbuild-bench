import { defineStore } from 'pinia'
import { ref } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import { useToast } from '@virgilvox/hackbuild-ui'
import type { Artifact } from '@/core/types'
import {
  buildPerform,
  triggerMatches,
} from '@/core/automations/actions'
import type {
  ActionConfig,
  ConditionConfig,
  TriggerConfig,
} from '@/core/automations/actions'
import { useSessionLog } from './sessionLog'

export interface Rule {
  id: string
  enabled: boolean
  fired: number
  lastFiredAt: number
  lastError?: string
  trigger: TriggerConfig
  condition: ConditionConfig
  action: ActionConfig
}

export interface RuleLogEntry {
  at: number
  ruleId: string
  message: string
  level: 'fire' | 'error'
}

export type RuleDraft = Pick<Rule, 'trigger' | 'condition' | 'action'>

/**
 * Trigger, condition, action rules over the device bus.
 *
 * A rule watches artifacts and runs a real action when one matches: write to
 * the log, notify, start recording, drive a pin on a board, or retune a radio.
 * Rules run in this tab and stop when it closes.
 */
export const useAutomations = defineStore('automations', () => {
  const rules = ref<Rule[]>([])
  const log = ref<RuleLogEntry[]>([])
  let counter = 0

  const { toast } = useToast()

  const env = {
    log: (message: string) => {
      pushLog('', message, 'fire')
      useSessionLog().note('automation', message)
    },
    notify: (message: string) => toast(message),
    setRecording: (on: boolean) => {
      const session = useSessionLog()
      if (on && !session.recording) session.start()
    },
  }

  function pushLog(ruleId: string, message: string, level: 'fire' | 'error'): void {
    log.value = [{ at: Date.now(), ruleId, message, level }, ...log.value].slice(0, 200)
  }

  bus.onArtifact((a: Artifact) => {
    for (const rule of rules.value) {
      if (!rule.enabled) continue
      if (!triggerMatches(rule.trigger, a)) continue

      const gap = rule.condition.minGapMs
      if (gap && Date.now() - rule.lastFiredAt < gap) continue

      rule.lastFiredAt = Date.now()
      rule.fired++

      const perform = buildPerform(rule.action, env)
      void perform(a).then(
        () => {
          rule.lastError = undefined
          pushLog(rule.id, describeFire(rule, a), 'fire')
        },
        (err: unknown) => {
          rule.lastError = err instanceof Error ? err.message : String(err)
          pushLog(rule.id, rule.lastError, 'error')
        },
      )
    }
  })

  function describeFire(rule: Rule, a: Artifact): string {
    const what =
      a.kind === 'packet'
        ? a.summary ?? a.proto
        : a.kind === 'line'
          ? a.text
          : a.kind === 'transcript'
            ? a.word
            : a.kind
    return `${rule.action.type} on "${what}"`
  }

  function addBlank(): void {
    const first = bus.nodes[0]
    rules.value = [
      ...rules.value,
      {
        id: `rule-${++counter}`,
        enabled: false,
        fired: 0,
        lastFiredAt: 0,
        trigger: { type: 'any', deviceId: first?.id },
        condition: { minGapMs: 2000 },
        action: { type: 'log' },
      },
    ]
  }

  /** Builds a rule straight from a captured artifact and an action device. */
  function addForArtifact(
    sourceId: string,
    match: string,
    actionDeviceId: string,
  ): void {
    rules.value = [
      ...rules.value,
      {
        id: `rule-${++counter}`,
        enabled: false,
        fired: 0,
        lastFiredAt: 0,
        trigger: { type: 'packet', deviceId: sourceId, match },
        condition: { minGapMs: 2000 },
        action: { type: 'pin', deviceId: actionDeviceId, pin: 2, pinMode: 'pulse' },
      },
    ]
  }

  function addRule(draft: RuleDraft): Rule {
    const rule: Rule = {
      id: `rule-${++counter}`,
      enabled: false,
      fired: 0,
      lastFiredAt: 0,
      ...draft,
    }
    rules.value = [...rules.value, rule]
    return rule
  }

  function update(id: string, patch: Partial<Pick<Rule, 'trigger' | 'condition' | 'action'>>): void {
    rules.value = rules.value.map((r) => (r.id === id ? { ...r, ...patch } : r))
  }

  function toggle(id: string): void {
    const r = rules.value.find((x) => x.id === id)
    if (r) r.enabled = !r.enabled
  }

  function remove(id: string): void {
    rules.value = rules.value.filter((r) => r.id !== id)
  }

  /** Fire a rule by hand, to check the action does what you expect. */
  async function test(id: string): Promise<void> {
    const rule = rules.value.find((r) => r.id === id)
    if (!rule) return
    const perform = buildPerform(rule.action, env)
    try {
      await perform({ kind: 'line', text: 'manual test', stream: 'note', source: '', t: 0, wall: Date.now(), seq: 0 })
      rule.lastError = undefined
      pushLog(rule.id, `tested ${rule.action.type}`, 'fire')
    } catch (err) {
      rule.lastError = err instanceof Error ? err.message : String(err)
      pushLog(rule.id, rule.lastError, 'error')
    }
  }

  return { rules, log, addBlank, addForArtifact, addRule, update, toggle, remove, test }
})

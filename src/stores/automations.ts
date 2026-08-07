import { defineStore } from 'pinia'
import { ref } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import type { Artifact } from '@/core/types'

export interface RuleClause {
  kind: string
  detail: string
}

export interface Rule {
  id: string
  enabled: boolean
  fired: number
  trigger: RuleClause & { deviceId?: string; match?: string }
  condition: RuleClause & { minGapMs?: number }
  action: RuleClause & { deviceId?: string }
  lastFiredAt: number
}

/**
 * Trigger, condition, action rules over the device bus.
 *
 * A rule watches artifacts from one device and calls an action on another.
 * Rules run in this tab only, and stop when the tab closes.
 */
export const useAutomations = defineStore('automations', () => {
  const rules = ref<Rule[]>([])
  let counter = 0

  bus.onArtifact((a: Artifact) => {
    for (const rule of rules.value) {
      if (!rule.enabled) continue
      if (rule.trigger.deviceId && rule.trigger.deviceId !== a.source) continue
      if (!matches(rule, a)) continue

      const gap = rule.condition.minGapMs ?? 0
      if (gap && Date.now() - rule.lastFiredAt < gap) continue

      rule.lastFiredAt = Date.now()
      rule.fired++
    }
  })

  function matches(rule: Rule, a: Artifact): boolean {
    const needle = rule.trigger.match
    if (!needle) return true
    if (a.kind === 'line') return a.text.includes(needle)
    if (a.kind === 'packet') return (a.summary ?? '').includes(needle)
    if (a.kind === 'transcript') return a.word.toLowerCase() === needle.toLowerCase()
    return false
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
        trigger: {
          kind: 'anything seen',
          detail: first ? `on ${first.label}` : 'on any device',
          deviceId: first?.id,
        },
        condition: { kind: 'rate limit', detail: 'once every 2 s', minGapMs: 2000 },
        action: { kind: 'log it', detail: 'write a line to the session log' },
      },
    ]
  }

  function toggle(id: string): void {
    const r = rules.value.find((x) => x.id === id)
    if (r) r.enabled = !r.enabled
  }

  function remove(id: string): void {
    rules.value = rules.value.filter((r) => r.id !== id)
  }

  return { rules, addBlank, toggle, remove }
})

import { bus } from '@/core/bus/DeviceBus'
import { PlaybookRunner } from '@/core/playbooks/runner'
import type { PlaybookHooks } from '@/core/playbooks/types'
import { useAutomations } from '@/stores/automations'
import { useBench } from '@/stores/bench'

/**
 * One runner for the session, so a playbook halfway through outlives the panel
 * that opened it. Built on first use so the stores it writes to already exist.
 */
let runner: PlaybookRunner | null = null

export function playbookRunner(): PlaybookRunner {
  if (runner) return runner
  const bench = useBench()
  const automations = useAutomations()
  const hooks: PlaybookHooks = {
    sendToAnalysis: (label, bytes) => bench.sendToAnalysis(label, bytes),
    createRule: (rule) => {
      const { deviceId, pin, level } = rule.action
      automations.addRule({
        trigger: {
          type: rule.trigger.match ? 'packet' : 'any',
          deviceId: rule.trigger.deviceId,
          match: rule.trigger.match,
        },
        condition: { minGapMs: rule.condition.minGapMs ?? 3000 },
        action:
          deviceId !== undefined && pin !== undefined && level !== undefined
            ? { type: 'pin', deviceId, pin, pinMode: level === 0 ? 'low' : 'high' }
            : { type: 'log' },
      })
    },
  }
  runner = new PlaybookRunner(bus, hooks)
  return runner
}

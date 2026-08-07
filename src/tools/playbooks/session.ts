import { bus } from '@/core/bus/DeviceBus'
import { PlaybookRunner } from '@/core/playbooks/runner'
import type { PlaybookHooks } from '@/core/playbooks/types'
import { useAutomations } from '@/stores/automations'
import { useBench } from '@/stores/bench'

/**
 * One runner for the session.
 *
 * A playbook halfway through survives a look at a device panel and is still
 * there when you come back, which a runner owned by the panel would not be.
 * Built on first use so the stores it writes to already exist.
 */
let runner: PlaybookRunner | null = null

export function playbookRunner(): PlaybookRunner {
  if (runner) return runner
  const bench = useBench()
  const automations = useAutomations()
  const hooks: PlaybookHooks = {
    sendToAnalysis: (label, bytes) => bench.sendToAnalysis(label, bytes),
    createRule: (rule) => {
      // translate the playbook's descriptive rule into the config model the
      // automations engine executes. a pin action becomes a real pin drive.
      const isPin = rule.action.deviceId !== undefined
      automations.addRule({
        trigger: {
          type: rule.trigger.match ? 'packet' : 'any',
          deviceId: rule.trigger.deviceId,
          match: rule.trigger.match,
        },
        condition: { minGapMs: rule.condition.minGapMs ?? 3000 },
        action: isPin
          ? { type: 'pin', deviceId: rule.action.deviceId, pin: 2, pinMode: 'pulse' }
          : { type: 'log' },
      })
    },
  }
  runner = new PlaybookRunner(bus, hooks)
  return runner
}

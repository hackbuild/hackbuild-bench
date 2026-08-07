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
      automations.addRule(rule)
    },
  }
  runner = new PlaybookRunner(bus, hooks)
  return runner
}

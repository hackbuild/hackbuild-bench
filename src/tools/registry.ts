import type { Capability } from '@/core/capabilities'
import type { DeviceNode } from '@/core/types'
import type { ToolManifest } from './types'

const registry = new Map<string, ToolManifest>()

export function registerTool(tool: ToolManifest): void {
  if (registry.has(tool.id)) {
    throw new Error(`tool ${tool.id} is already registered`)
  }
  registry.set(tool.id, tool)
}

export function registerTools(tools: ToolManifest[]): void {
  for (const t of tools) registerTool(t)
}

export function allTools(): ToolManifest[] {
  return [...registry.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
}

export function tool(id: string): ToolManifest | undefined {
  return registry.get(id)
}

export function benchTools(): ToolManifest[] {
  return allTools().filter((t) => t.scope === 'bench')
}

/**
 * The tools that belong in this device's control plane, in tab order.
 *
 * A tool qualifies when the device provides every capability it requires and,
 * where the tool names specific kinds, when the device is one of them.
 */
export function toolsForDevice(node: DeviceNode, advanced: boolean): ToolManifest[] {
  return allTools().filter((t) => {
    if (t.scope !== 'device') return false
    if (t.advanced && !advanced) return false
    if (t.onlyKinds && !t.onlyKinds.includes(node.kind)) return false
    return t.requires.every((c) => node.capabilities.includes(c))
  })
}

/**
 * Tools a device cannot run, paired with the capability it is missing, so the
 * plane can show a disabled tab with the honest reason rather than hiding it.
 */
export function unmetToolsForDevice(
  node: DeviceNode,
  advanced: boolean,
): Array<{ tool: ToolManifest; missing: Capability[] }> {
  return allTools()
    .filter((t) => t.scope === 'device')
    .filter((t) => !t.advanced || advanced)
    .filter((t) => !t.onlyKinds || t.onlyKinds.includes(node.kind))
    .map((t) => ({
      tool: t,
      missing: t.requires.filter((c) => !node.capabilities.includes(c)),
    }))
    .filter((x) => x.missing.length > 0)
}

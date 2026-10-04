import { defineStore } from 'pinia'
import { computed, ref, shallowRef, triggerRef } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import type { Capability } from '@/core/capabilities'
import type { DeviceNode, TransportKind } from '@/core/types'
import type { DeviceHandle } from '@/core/drivers/types'

const MEMORY_KEY = 'hackbuild.bench.units'

type UnitMemory = Record<string, Record<string, number>>

function loadMemory(): UnitMemory {
  try {
    const raw = localStorage.getItem(MEMORY_KEY)
    if (raw) return JSON.parse(raw) as UnitMemory
  } catch {
    // corrupt or unavailable storage starts empty.
  }
  return {}
}

/**
 * Cheap sticks share serials, every unmodified RTL2832U says 00000001, so the
 * tuner the driver found is part of the key. Two identical sticks still share
 * one memory, since nothing the browser can read tells them apart.
 */
function unitKey(node: DeviceNode): string {
  const chip = node.info.tuner ? `:${node.info.tuner}` : ''
  return `${node.kind}:${node.uid}${chip}`
}

/** The params this unit keeps between connects, with their current values. */
function rememberedOf(node: DeviceNode): Record<string, number> {
  const out: Record<string, number> = {}
  for (const p of node.descriptor.params) {
    if (p.remember && node.params[p.key] !== undefined) out[p.key] = node.params[p.key]
  }
  return out
}

/**
 * Reactive mirror of the device bus.
 *
 * The bus owns the truth and knows nothing about Vue. This store subscribes to
 * its events and re-exposes the node list reactively. Components read from
 * here and call through to the bus for anything that changes hardware state.
 */
export const useDevices = defineStore('devices', () => {
  const nodes = shallowRef<DeviceNode[]>([])
  const focusId = ref<string | null>(null)
  const connecting = ref(false)
  const lastError = ref<string | null>(null)
  const logs = ref<Array<{ deviceId: string; message: string; at: number }>>([])
  const memory = loadMemory()

  function remember(id: string): void {
    const node = bus.node(id)
    if (!node) return
    const values = rememberedOf(node)
    if (!Object.keys(values).length) return
    const key = unitKey(node)
    const was = memory[key]
    // a sweep fires a params event per hop, and none of them touch a remembered value.
    if (was && Object.keys(values).every((k) => was[k] === values[k])) return
    memory[key] = values
    try {
      localStorage.setItem(MEMORY_KEY, JSON.stringify(memory))
    } catch {
      // private browsing. the unit starts from defaults next time.
    }
  }

  /**
   * The bus mutates its nodes in place and knows nothing about Vue, so each
   * one is copied here. Without the copy a computed that reads a node keeps
   * the same object identity, never invalidates, and a panel goes on showing
   * idle while the device streams.
   */
  function sync(): void {
    nodes.value = bus.nodes.map((n) => ({ ...n }))
    triggerRef(nodes)
  }

  bus.onEvent((e) => {
    if (e.type === 'log' && e.message) {
      logs.value.push({ deviceId: e.deviceId, message: e.message, at: e.at })
      if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500)
    }
    if (e.type === 'error' && e.message) lastError.value = e.message
    if (e.type === 'params') remember(e.deviceId)
    sync()
  })

  const focused = computed(() => nodes.value.find((n) => n.id === focusId.value) ?? null)
  const count = computed(() => nodes.value.length)

  function focus(id: string | null): void {
    focusId.value = id
  }

  /** Every connected device that provides this capability. */
  function providers(cap: Capability): DeviceNode[] {
    return nodes.value.filter((n) => n.capabilities.includes(cap))
  }

  function canProvide(caps: Capability[]): boolean {
    return caps.every((c) => providers(c).length > 0)
  }

  async function connect(
    kind: string,
    transport: TransportKind,
    fields?: Record<string, string>,
  ): Promise<DeviceNode | null> {
    connecting.value = true
    lastError.value = null
    try {
      const handle = await bus.requestAccess(kind, transport, fields)
      if (!handle) return null
      const node = await attach(handle)
      focusId.value = node.id
      return node
    } catch (err) {
      // a dismissed picker is a normal outcome, not a failure worth surfacing.
      const msg = err instanceof Error ? err.message : String(err)
      if (!/no device selected|cancelled|user gesture/i.test(msg)) lastError.value = msg
      return null
    } finally {
      connecting.value = false
      sync()
    }
  }

  /** Puts a chosen device on the bus with whatever this unit remembered from last time. */
  async function attach(handle: DeviceHandle): Promise<DeviceNode> {
    const node = await bus.attach(handle)
    const stored = memory[unitKey(node)]
    if (stored) {
      const known = new Set(Object.keys(rememberedOf(node)))
      const restore = Object.fromEntries(Object.entries(stored).filter(([k]) => known.has(k)))
      if (Object.keys(restore).length) await configure(node.id, restore)
    }
    sync()
    return node
  }

  async function disconnect(id: string): Promise<void> {
    await bus.detach(id)
    // sync first, otherwise the next focus is picked out of the old list and
    // can land on the device that was just removed.
    sync()
    if (focusId.value === id) focusId.value = nodes.value[0]?.id ?? null
  }

  /**
   * The scan and sweep loops await this on every hop and must survive a hop the
   * radio refuses, so a refusal reaches the panel through the bus error event
   * and node.error alone.
   */
  async function configure(id: string, params: Record<string, number>): Promise<void> {
    try {
      await bus.configure(id, params)
    } catch {
      // already reported through the bus error event.
    }
    sync()
  }

  async function start(id: string, mode: string): Promise<void> {
    await bus.start(id, mode)
    sync()
  }

  async function stop(id: string): Promise<void> {
    await bus.stop(id)
    sync()
  }

  function arm(id: string, cap: Capability): void {
    bus.arm(id, cap)
    sync()
  }

  function disarm(id: string, cap: Capability): void {
    bus.disarm(id, cap)
    sync()
  }

  function logsFor(id: string) {
    return computed(() => logs.value.filter((l) => l.deviceId === id))
  }

  return {
    nodes,
    focusId,
    focused,
    count,
    connecting,
    lastError,
    logs,
    focus,
    providers,
    canProvide,
    connect,
    attach,
    disconnect,
    configure,
    start,
    stop,
    arm,
    disarm,
    logsFor,
    sync,
  }
})

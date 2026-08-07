import { defineStore } from 'pinia'
import { computed, ref, shallowRef, triggerRef } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import type { Capability } from '@/core/capabilities'
import type { DeviceNode, TransportKind } from '@/core/types'

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

  function sync(): void {
    nodes.value = [...bus.nodes]
    triggerRef(nodes)
  }

  bus.onEvent((e) => {
    if (e.type === 'log' && e.message) {
      logs.value.push({ deviceId: e.deviceId, message: e.message, at: e.at })
      if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500)
    }
    if (e.type === 'error' && e.message) lastError.value = e.message
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
      const node = await bus.attach(handle)
      sync()
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

  async function disconnect(id: string): Promise<void> {
    await bus.detach(id)
    if (focusId.value === id) focusId.value = nodes.value[0]?.id ?? null
    sync()
  }

  async function configure(id: string, params: Record<string, number>): Promise<void> {
    await bus.configure(id, params)
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

  function rename(id: string, label: string): void {
    bus.rename(id, label)
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
    disconnect,
    configure,
    start,
    stop,
    arm,
    disarm,
    rename,
    logsFor,
    sync,
  }
})

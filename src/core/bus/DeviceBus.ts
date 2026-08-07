import type { Capability } from '../capabilities'
import { impactOf } from '../capabilities'
import type { Artifact, ArtifactDraft, BusEvent, DeviceNode, TransportKind } from '../types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '../drivers/types'

type ArtifactListener = (a: Artifact) => void
type EventListener = (e: BusEvent) => void

interface Live {
  node: DeviceNode
  session: DeviceSession
  driver: DeviceDriver
  abort: AbortController
  seq: number
}

/**
 * The device bus.
 *
 * Holds every connected device, routes their artifacts to subscribers, and
 * answers capability queries. Tools ask it for a provider of a capability and
 * never name a device kind.
 *
 * This class has no Vue dependency. The Pinia store mirrors it reactively.
 */
export class DeviceBus {
  private live = new Map<string, Live>()
  private drivers = new Map<string, DeviceDriver>()
  private artifactSubs = new Set<ArtifactListener>()
  private eventSubs = new Set<EventListener>()
  /** Per device subscriptions, so a panel only pays for the device it shows. */
  private deviceSubs = new Map<string, Set<ArtifactListener>>()
  private counter = 0
  private healthTimer: ReturnType<typeof setInterval> | null = null

  registerDriver(driver: DeviceDriver): void {
    this.drivers.set(driver.descriptor.kind, driver)
  }

  getDriver(kind: string): DeviceDriver | undefined {
    return this.drivers.get(kind)
  }

  listDrivers(): DeviceDriver[] {
    return [...this.drivers.values()]
  }

  get nodes(): DeviceNode[] {
    return [...this.live.values()].map((l) => l.node)
  }

  node(id: string): DeviceNode | undefined {
    return this.live.get(id)?.node
  }

  /**
   * The live session for a device, for panels that need methods beyond the
   * adapter contract: a serial write, a pin set, an i2c scan.
   *
   * The caller names the interface its driver exports, so the call stays
   * typed. A panel that reaches for a method the connected device does not
   * have gets undefined back and must handle it.
   */
  session<T extends DeviceSession = DeviceSession>(id: string): T | undefined {
    return this.live.get(id)?.session as T | undefined
  }

  // -------------------------------------------------------------------------
  // capability routing. the reason tools do not name devices.
  // -------------------------------------------------------------------------

  /** Every connected device that provides this capability. */
  providers(cap: Capability): DeviceNode[] {
    return this.nodes.filter((n) => n.capabilities.includes(cap))
  }

  /** True when at least one connected device provides all of these. */
  canProvide(caps: Capability[]): boolean {
    return caps.every((c) => this.providers(c).length > 0)
  }

  /** The first provider, used when a tool just needs any device that can. */
  provider(cap: Capability): DeviceNode | undefined {
    return this.providers(cap)[0]
  }

  // -------------------------------------------------------------------------
  // connection lifecycle
  // -------------------------------------------------------------------------

  async requestAccess(
    kind: string,
    transport: TransportKind,
    fields?: Record<string, string>,
  ): Promise<DeviceHandle | null> {
    const driver = this.drivers.get(kind)
    if (!driver) throw new Error(`no driver registered for ${kind}`)
    return driver.requestAccess(transport, fields)
  }

  async attach(handle: DeviceHandle): Promise<DeviceNode> {
    const driver = this.drivers.get(handle.kind)
    if (!driver) throw new Error(`no driver registered for ${handle.kind}`)

    const id = `${handle.kind}-${++this.counter}`
    const sameKind = this.nodes.filter((n) => n.kind === handle.kind).length
    const abort = new AbortController()

    const node: DeviceNode = {
      id,
      kind: handle.kind,
      label: sameKind > 0 ? `${handle.label} ${sameKind + 1}` : handle.label,
      descriptor: driver.descriptor,
      transport: handle.transport,
      status: 'opening',
      capabilities: [],
      armed: [],
      params: Object.fromEntries(driver.descriptor.params.map((p) => [p.key, p.default])),
      info: {},
      connectedAt: Date.now(),
    }

    const entry: Live = { node, session: null as unknown as DeviceSession, driver, abort, seq: 0 }
    this.live.set(id, entry)
    this.fire({ type: 'attached', deviceId: id, at: Date.now() })

    const ctx: DriverContext = {
      emit: (a) => this.dispatch(id, entry, a),
      log: (message) => this.fire({ type: 'log', deviceId: id, message, at: Date.now() }),
      setInfo: (info) => {
        Object.assign(node.info, info)
        this.fire({ type: 'info', deviceId: id, at: Date.now() })
      },
      isArmed: (cap) => node.armed.includes(cap),
      signal: abort.signal,
    }

    try {
      const session = await driver.open(handle, ctx)
      entry.session = session
      node.capabilities = session.getCapabilities()
      Object.assign(node.info, session.getInfo())
      node.status = 'idle'
      this.fire({ type: 'status', deviceId: id, at: Date.now() })
      this.ensureHealthLoop()
      return node
    } catch (err) {
      node.status = 'error'
      node.error = err instanceof Error ? err.message : String(err)
      this.fire({ type: 'error', deviceId: id, message: node.error, at: Date.now() })
      throw err
    }
  }

  async detach(id: string): Promise<void> {
    const entry = this.live.get(id)
    if (!entry) return
    entry.abort.abort()
    try {
      await entry.session?.resetToSafeState()
      await entry.session?.close()
    } catch {
      // the device may already be unplugged. removal still proceeds.
    }
    this.live.delete(id)
    this.deviceSubs.delete(id)
    this.fire({ type: 'detached', deviceId: id, at: Date.now() })
    if (this.live.size === 0) this.stopHealthLoop()
  }

  async detachAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.detach(id)))
  }

  // -------------------------------------------------------------------------
  // operation
  // -------------------------------------------------------------------------

  async configure(id: string, params: Record<string, number>): Promise<void> {
    const entry = this.expect(id)
    Object.assign(entry.node.params, params)
    await entry.session.configure(entry.node.params)
    this.fire({ type: 'params', deviceId: id, at: Date.now() })
  }

  async start(id: string, mode: string): Promise<void> {
    const entry = this.expect(id)
    entry.node.status = 'streaming'
    this.fire({ type: 'status', deviceId: id, at: Date.now() })
    try {
      await entry.session.start(mode)
    } catch (err) {
      entry.node.status = 'error'
      entry.node.error = err instanceof Error ? err.message : String(err)
      this.fire({ type: 'error', deviceId: id, message: entry.node.error, at: Date.now() })
      throw err
    }
  }

  async stop(id: string): Promise<void> {
    const entry = this.expect(id)
    await entry.session.stop()
    entry.node.status = 'idle'
    this.fire({ type: 'status', deviceId: id, at: Date.now() })
  }

  /**
   * Arm a consequential capability for this session. Observe capabilities are
   * always available and arming them is a no-op.
   */
  arm(id: string, cap: Capability): void {
    const entry = this.expect(id)
    if (impactOf(cap) === 'observe') return
    if (!entry.node.armed.includes(cap)) entry.node.armed.push(cap)
    this.fire({ type: 'armed', deviceId: id, at: Date.now() })
  }

  disarm(id: string, cap: Capability): void {
    const entry = this.expect(id)
    entry.node.armed = entry.node.armed.filter((c) => c !== cap)
    this.fire({ type: 'armed', deviceId: id, at: Date.now() })
  }

  rename(id: string, label: string): void {
    this.expect(id).node.label = label
    this.fire({ type: 'status', deviceId: id, at: Date.now() })
  }

  // -------------------------------------------------------------------------
  // subscriptions
  // -------------------------------------------------------------------------

  /** Every artifact from every device. Used by the recorder and analysis. */
  onArtifact(fn: ArtifactListener): () => void {
    this.artifactSubs.add(fn)
    return () => this.artifactSubs.delete(fn)
  }

  /** Artifacts from one device. Used by a control plane. */
  onDeviceArtifact(id: string, fn: ArtifactListener): () => void {
    let set = this.deviceSubs.get(id)
    if (!set) {
      set = new Set()
      this.deviceSubs.set(id, set)
    }
    set.add(fn)
    return () => set?.delete(fn)
  }

  onEvent(fn: EventListener): () => void {
    this.eventSubs.add(fn)
    return () => this.eventSubs.delete(fn)
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private expect(id: string): Live {
    const entry = this.live.get(id)
    if (!entry) throw new Error(`device ${id} is not attached`)
    return entry
  }

  /**
   * Publish demodulated audio for a device from outside the driver.
   *
   * The rtl-sdr driver emits raw iq and the demodulation to audio happens in
   * the receiver composable, so the resulting audio has to re-enter the bus
   * here to reach the transcriber and the recorder the same way a driver that
   * demodulates on its own would emit it.
   */
  emitAudio(id: string, samples: Float32Array, sampleRate: number): void {
    const entry = this.live.get(id)
    if (!entry) return
    this.dispatch(id, entry, { kind: 'audio', samples, sampleRate })
  }

  private dispatch(
    id: string,
    entry: Live,
    partial: ArtifactDraft,
  ): void {
    const artifact = {
      ...partial,
      source: id,
      seq: entry.seq++,
      t: performance.now(),
      wall: Date.now(),
    } as Artifact

    const perDevice = this.deviceSubs.get(id)
    if (perDevice) for (const fn of perDevice) fn(artifact)
    for (const fn of this.artifactSubs) fn(artifact)
  }

  private fire(e: BusEvent): void {
    for (const fn of this.eventSubs) fn(e)
  }

  private ensureHealthLoop(): void {
    if (this.healthTimer) return
    this.healthTimer = setInterval(() => {
      void this.pollHealth()
    }, 4000)
  }

  private stopHealthLoop(): void {
    if (!this.healthTimer) return
    clearInterval(this.healthTimer)
    this.healthTimer = null
  }

  private async pollHealth(): Promise<void> {
    for (const [id, entry] of this.live) {
      if (!entry.session) continue
      let alive = true
      try {
        alive = await entry.session.health()
      } catch {
        alive = false
      }
      if (!alive && entry.node.status !== 'error') {
        entry.node.status = 'error'
        entry.node.error = 'device stopped responding, it may have been unplugged'
        this.fire({ type: 'error', deviceId: id, message: entry.node.error, at: Date.now() })
      }
    }
  }
}

export const bus = new DeviceBus()

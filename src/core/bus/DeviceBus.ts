import type { Capability } from '../capabilities'
import { impactOf } from '../capabilities'
import type { Artifact, ArtifactDraft, BusEvent, DeviceNode, TransportKind } from '../types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '../drivers/types'

type ArtifactListener = (a: Artifact) => void
type EventListener = (e: BusEvent) => void

interface Live {
  node: DeviceNode
  /** The handle it was attached from, to match a usb disconnect to its node. */
  handle: DeviceHandle
  /** Null between attach() inserting the entry and driver.open() returning. */
  session: DeviceSession | null
  driver: DeviceDriver
  abort: AbortController
  seq: number
  /**
   * Configure calls run one at a time, each merged against the params the
   * last one left. Merged at call time instead, a knob moved while a sweep
   * hop is in flight would carry the previous hop's frequency and undo it.
   */
  configuring: Promise<unknown>
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
  private usbWatching = false

  /**
   * Detaches a device the browser says was unplugged, so a lost radio reads
   * as gone rather than as a raw transfer error on the next control write.
   */
  private watchUsb(): void {
    if (this.usbWatching || typeof navigator === 'undefined' || !navigator.usb) return
    this.usbWatching = true
    navigator.usb.addEventListener('disconnect', (ev) => {
      const device = (ev as USBConnectionEvent).device
      for (const [id, entry] of this.live) {
        const raw = entry.handle.raw as { device?: USBDevice } | undefined
        if (raw && raw.device === device) {
          this.fire({ type: 'log', deviceId: id, message: 'the radio was unplugged', at: Date.now() })
          void this.detach(id).catch(() => undefined)
        }
      }
    })
  }

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
    return (this.live.get(id)?.session ?? undefined) as T | undefined
  }

  // -------------------------------------------------------------------------
  // capability routing. the reason tools do not name devices.
  // -------------------------------------------------------------------------

  /** Every connected device that provides this capability. */
  providers(cap: Capability): DeviceNode[] {
    // a recording provides iq too, but a tool asking for any device means a live one.
    const live = (n: DeviceNode) => (n.transport === 'file' ? 1 : 0)
    return this.nodes.filter((n) => n.capabilities.includes(cap)).sort((a, b) => live(a) - live(b))
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
    // the suffix is the first free slot for this kind, so two live units never
    // collide and a lone device that reconnects gets its plain label back.
    const taken = new Set(this.nodes.filter((n) => n.kind === handle.kind).map((n) => n.label))
    let label = handle.label
    for (let n = 2; taken.has(label); n++) label = `${handle.label} ${n}`
    const abort = new AbortController()

    const node: DeviceNode = {
      id,
      kind: handle.kind,
      label,
      uid: handle.uid,
      descriptor: driver.descriptor,
      transport: handle.transport,
      status: 'opening',
      capabilities: [],
      armed: [],
      params: Object.fromEntries(driver.descriptor.params.map((p) => [p.key, p.default])),
      info: {},
      connectedAt: Date.now(),
    }

    const entry: Live = { node, handle, session: null, driver, abort, seq: 0, configuring: Promise.resolve() }
    this.live.set(id, entry)
    this.watchUsb()
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
      stopped: (reason) => {
        if (node.status !== 'streaming') return
        node.status = 'idle'
        this.fire({ type: 'log', deviceId: id, message: reason, at: Date.now() })
        this.fire({ type: 'status', deviceId: id, at: Date.now() })
      },
    }

    try {
      const session = await driver.open(handle, ctx)
      // a detach while open was running has already dropped this entry, and
      // nothing else would release what the driver just claimed.
      if (abort.signal.aborted) {
        await session.close().catch(() => undefined)
        throw new Error(`${node.label} was let go before it finished opening`)
      }
      entry.session = session
      if (this.narrow(node, driver, session)) {
        node.params = Object.fromEntries(node.descriptor.params.map((p) => [p.key, p.default]))
      }
      // the panel shows node.params from the descriptor defaults, so the session
      // has to hold those same values before the first knob move.
      try {
        await session.configure({ ...node.params })
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        this.fire({ type: 'log', deviceId: id, message: `defaults not applied: ${why}`, at: Date.now() })
      }
      // the same holds for a detach that landed while the defaults went in.
      if (abort.signal.aborted) {
        await session.close().catch(() => undefined)
        throw new Error(`${node.label} was let go before it finished opening`)
      }
      node.capabilities = session.getCapabilities()
      Object.assign(node.info, session.getInfo())
      node.status = 'idle'
      this.fire({ type: 'status', deviceId: id, at: Date.now() })
      this.ensureHealthLoop()
      return node
    } catch (err) {
      if (!this.live.has(id)) throw err
      node.status = 'error'
      node.error = friendlyError(err)
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
    const entry = this.expectSession(id)
    const run = entry.configuring.then(
      () => this.applyParams(id, entry, params),
      () => this.applyParams(id, entry, params),
    )
    entry.configuring = run.catch(() => undefined)
    return run
  }

  private async applyParams(
    id: string,
    entry: Live & { session: DeviceSession },
    params: Record<string, number>,
  ): Promise<void> {
    // queued behind a detach, the session is closed and the node is gone.
    if (this.live.get(id) !== entry) return
    const prev = { ...entry.node.params }
    const next = { ...entry.node.params, ...params }
    try {
      await entry.session.configure(next)
    } catch (err) {
      // the panel must not show a value the radio rejected.
      entry.node.params = prev
      const why = err instanceof Error ? err.message : String(err)
      // a sweep that hops through a refused range must not fill the session log
      // with one line per hop.
      if (entry.node.error !== why) {
        this.fire({ type: 'error', deviceId: id, message: why, at: Date.now() })
      }
      entry.node.error = why
      throw err
    }
    entry.node.params = next
    entry.node.error = undefined
    this.narrow(entry.node, entry.driver, entry.session)
    this.fire({ type: 'params', deviceId: id, at: Date.now() })
  }

  async start(id: string, mode: string): Promise<void> {
    const entry = this.expectSession(id)
    entry.node.status = 'streaming'
    this.fire({ type: 'status', deviceId: id, at: Date.now() })
    try {
      await entry.session.start(mode)
      entry.node.error = undefined
    } catch (err) {
      entry.node.status = 'error'
      entry.node.error = friendlyError(err)
      this.fire({ type: 'error', deviceId: id, message: entry.node.error, at: Date.now() })
      throw err
    }
  }

  async stop(id: string): Promise<void> {
    const entry = this.expectSession(id)
    try {
      await entry.session.stop()
    } catch (err) {
      entry.node.status = 'error'
      entry.node.error = friendlyError(err)
      this.fire({ type: 'error', deviceId: id, message: entry.node.error, at: Date.now() })
      throw err
    }
    entry.node.error = undefined
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

  /** Applies what the session says about this unit. True when it said anything. */
  private narrow(node: DeviceNode, driver: DeviceDriver, session: DeviceSession): boolean {
    const own = session.describe?.()
    if (!own) return false
    node.descriptor = { ...driver.descriptor, ...own }
    return true
  }

  private expect(id: string): Live {
    const entry = this.live.get(id)
    if (!entry) throw new Error(`device ${id} is not attached`)
    return entry
  }

  private expectSession(id: string): Live & { session: DeviceSession } {
    const entry = this.expect(id)
    if (!entry.session) throw new Error(`device ${id} never finished opening`)
    return entry as Live & { session: DeviceSession }
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

  /**
   * Publish a decoded record for a device from outside the driver.
   *
   * A decoder that turns a radio's iq into packets, readings or pictures runs
   * in the panel, the same as the demodulation behind emitAudio, so its
   * records come in here and reach the session log, the recorder and the
   * automations as that device's own.
   */
  emitDecoded(
    id: string,
    draft: Extract<ArtifactDraft, { kind: 'packet' | 'reading' | 'blob' }>,
  ): void {
    const entry = this.live.get(id)
    if (!entry) return
    this.dispatch(id, entry, draft)
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

/**
 * A plain message for the errors a radio throws when it goes away, so a
 * yanked usb cable or a power glitch reads as what it is rather than as a
 * transfer failure. Other errors pass through unchanged.
 */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  if (/disconnect|no device selected|device was lost|transfer(in|out)|the device was/i.test(raw)) {
    return 'the radio was unplugged or lost power. plug it back in and connect again.'
  }
  return raw
}

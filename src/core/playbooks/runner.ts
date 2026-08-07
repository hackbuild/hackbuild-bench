import { CAPABILITIES, CAPABILITY_LABELS } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import type { DeviceBus } from '@/core/bus/DeviceBus'
import type { DeviceSession } from '@/core/drivers/types'
import { isSimKind } from '@/core/drivers/sim/simulate'
import type { Artifact, DeviceNode } from '@/core/types'
import type {
  CollectRequest,
  Playbook,
  PlaybookChoice,
  PlaybookContext,
  PlaybookHooks,
  PlaybookStep,
} from './types'

/**
 * Start modes are driver strings and the bus has no map from capability to
 * mode, so the runner tries the known names in order and keeps the one that
 * takes. A driver that rejects a mode throws, which is how the loop moves on.
 */
const MODES_FOR: Partial<Record<Capability, string[]>> = {
  [CAPABILITIES.CAPTURE_IQ]: ['iq', 'rx'],
  [CAPABILITIES.OBSERVE_SPECTRUM]: ['spectrum', 'iq', 'rx'],
  [CAPABILITIES.CAPTURE_PACKET]: ['ble', 'classic', 'listen', 'survey', 'rx'],
  [CAPABILITIES.MESH_RX]: ['listen'],
  [CAPABILITIES.NET_SURVEY]: ['survey'],
  [CAPABILITIES.SERIAL_CONSOLE]: ['console'],
  [CAPABILITIES.CAPTURE_LOGIC]: ['logic'],
}

/** What a capability does, in words someone can act on. */
const CAP_VERB: Record<Capability, string> = {
  [CAPABILITIES.OBSERVE_SPECTRUM]: 'show what is on the air',
  [CAPABILITIES.CAPTURE_IQ]: 'record raw radio samples',
  [CAPABILITIES.CAPTURE_PACKET]: 'sniff packets',
  [CAPABILITIES.CAPTURE_LOGIC]: 'capture logic lines',
  [CAPABILITIES.AUDIO_DEMOD]: 'demodulate audio',
  [CAPABILITIES.CONNECT_GATT]: 'connect to a bluetooth device',
  [CAPABILITIES.BUS_READ]: 'read an i2c or spi bus',
  [CAPABILITIES.DEBUG_READ]: 'read a debug port',
  [CAPABILITIES.SERIAL_CONSOLE]: 'open a serial console',
  [CAPABILITIES.MESH_RX]: 'hear a mesh',
  [CAPABILITIES.NET_SURVEY]: 'survey wifi',
  [CAPABILITIES.GNSS_FIX]: 'get a gnss fix',
  [CAPABILITIES.TRANSMIT_RF]: 'transmit',
  [CAPABILITIES.REPLAY_PACKET]: 'replay a frame',
  [CAPABILITIES.FUZZ_PROTOCOL]: 'fuzz a protocol',
  [CAPABILITIES.BUS_DRIVE]: 'drive a bus',
  [CAPABILITIES.DEBUG_WRITE]: 'write over a debug port',
  [CAPABILITIES.FLASH_PROGRAM]: 'write firmware',
  [CAPABILITIES.FLASH_ERASE]: 'erase flash',
  [CAPABILITIES.POWER_SOURCE]: 'power a target',
  [CAPABILITIES.MESH_TX]: 'send on a mesh',
  [CAPABILITIES.NET_ATTACK]: 'act on nearby wifi clients',
  [CAPABILITIES.GPIO_DRIVE]: 'drive pins',
}

/**
 * The line that tells the user what to plug in. The example comes from the
 * driver registry rather than a hardcoded list, so it stays true as hardware
 * support grows.
 */
export function needsText(cap: Capability, bus: DeviceBus): string {
  const verb = CAP_VERB[cap] ?? CAPABILITY_LABELS[cap]
  const example = bus
    .listDrivers()
    .filter((d) => !isSimKind(d.descriptor.kind))
    .find((d) => d.descriptor.capabilities.includes(cap))
  return example
    ? `needs something that can ${verb}, like a ${example.descriptor.name.toLowerCase()}`
    : `needs something that can ${verb}`
}

export interface StepReadiness {
  ready: boolean
  missing: Capability[]
  /** Empty when ready. */
  reason: string
}

export interface StepStatus {
  index: number
  step: PlaybookStep
  complete: boolean
  current: boolean
  readiness: StepReadiness
  /** The device the arm applies to, when the step arms something. */
  armNode: DeviceNode | null
  armed: boolean
}

export interface PlaybookLine {
  at: number
  text: string
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Runs one playbook.
 *
 * The class holds no Vue. It reports changes through onChange, which the panel
 * turns into a render. Completion is polled from the steps themselves so a
 * capture that lands while the user is reading still moves the sequence on.
 */
export class PlaybookRunner {
  playbook: Playbook | null = null
  index = 0
  scratch: Record<string, unknown> = {}
  lines: PlaybookLine[] = []
  busy = false
  error: string | null = null

  private readonly bus: DeviceBus
  private readonly hooks: PlaybookHooks
  private readonly ctx: PlaybookContext
  private subs = new Set<() => void>()
  private timer: ReturnType<typeof setInterval> | null = null
  private runAbort: AbortController | null = null
  private announced = new Set<string>()
  private lastSignature = ''
  private scratchVersion = 0

  constructor(bus: DeviceBus, hooks: PlaybookHooks) {
    this.bus = bus
    this.hooks = hooks
    this.ctx = this.makeContext()
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  start(playbook: Playbook): void {
    this.abortRun()
    this.playbook = playbook
    this.index = 0
    this.scratch = {}
    this.ctx.scratch = this.scratch
    this.lines = []
    this.error = null
    this.busy = false
    this.announced.clear()
    this.log(`${playbook.title} started`)
    this.seedChoice(playbook.steps[0])
    if (!this.timer) this.timer = setInterval(() => this.tick(), 350)
    this.touch()
  }

  abort(): void {
    this.abortRun()
    if (this.playbook) this.log('stopped')
    this.playbook = null
    this.busy = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.touch()
  }

  onChange(fn: () => void): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  // -------------------------------------------------------------------------
  // steps
  // -------------------------------------------------------------------------

  get steps(): PlaybookStep[] {
    return this.playbook?.steps ?? []
  }

  get statuses(): StepStatus[] {
    return this.steps.map((step, index) => {
      const armNode = this.armNode(step)
      return {
        index,
        step,
        complete: this.isComplete(step),
        current: index === this.index,
        readiness: this.readiness(step),
        armNode,
        armed: armNode && step.arms ? armNode.armed.includes(step.arms) : false,
      }
    })
  }

  /** True when nothing is left that the bench can actually do. */
  get settled(): boolean {
    if (!this.playbook) return false
    return this.steps.every((s) => this.isComplete(s) || !this.readiness(s).ready)
  }

  get finished(): boolean {
    return !!this.playbook && this.steps.every((s) => this.isComplete(s))
  }

  /** Steps the bench cannot reach, so the panel can name what is missing. */
  get blocked(): StepStatus[] {
    return this.statuses.filter((s) => !s.complete && !s.readiness.ready)
  }

  isComplete(step: PlaybookStep): boolean {
    try {
      return step.isComplete(this.ctx)
    } catch {
      // a step that throws while reporting is not done.
      return false
    }
  }

  readiness(step: PlaybookStep): StepReadiness {
    const missing = step.requires.filter((c) => this.bus.providers(c).length === 0)
    const any = step.requiresAny ?? []
    const anyMissing = any.length > 0 && any.every((c) => this.bus.providers(c).length === 0)
    if (anyMissing) missing.push(any[0])
    if (!missing.length) return { ready: true, missing, reason: '' }
    return {
      ready: false,
      missing,
      reason: missing.map((c) => needsText(c, this.bus)).join(', and it '),
    }
  }

  /** The device an arm step acts on. */
  armNode(step: PlaybookStep): DeviceNode | null {
    if (!step.arms) return null
    const chosen = step.armOn?.(this.ctx)
    const node = chosen ? this.bus.node(chosen) : undefined
    if (node && node.capabilities.includes(step.arms)) return node
    return this.bus.provider(step.arms) ?? null
  }

  choose(step: PlaybookStep, value: string | number): void {
    if (!step.choiceKey) return
    this.write(step.choiceKey, value)
  }

  /** The one place scratch changes, so a value edit reaches the panel. */
  write(key: string, value: unknown): void {
    this.scratch[key] = value
    this.scratchVersion++
    this.touch()
  }

  /** The picks a step offers right now, from whatever it has collected. */
  choicesFor(step: PlaybookStep): PlaybookChoice[] {
    try {
      return step.choices?.(this.ctx) ?? []
    } catch {
      return []
    }
  }

  summaryFor(step: PlaybookStep): string[] {
    try {
      return step.summary?.(this.ctx) ?? []
    } catch {
      return []
    }
  }

  bytesFor(step: PlaybookStep): Uint8Array | null {
    try {
      return step.bytes?.(this.ctx) ?? null
    } catch {
      return null
    }
  }

  chosen(step: PlaybookStep): string | number | undefined {
    if (!step.choiceKey) return undefined
    const v = this.scratch[step.choiceKey]
    return typeof v === 'string' || typeof v === 'number' ? v : undefined
  }

  goTo(index: number): void {
    if (index < 0 || index >= this.steps.length) return
    this.index = index
    this.seedChoice(this.steps[index])
    this.touch()
  }

  advance(): void {
    const next = this.steps.findIndex((s, i) => i > this.index && !this.isComplete(s))
    this.goTo(next === -1 ? this.steps.length - 1 : next)
  }

  /** Run the current step's action. */
  async runCurrent(): Promise<void> {
    const step = this.steps[this.index]
    if (!step?.run || this.busy) return

    const ready = this.readiness(step)
    if (!ready.ready) {
      this.error = `this step ${ready.reason}`
      this.touch()
      return
    }

    this.busy = true
    this.error = null
    this.runAbort = new AbortController()
    this.touch()
    try {
      await step.run(this.ctx)
    } catch (err) {
      this.error = message(err)
      this.log(`${step.title}: ${this.error}`)
    } finally {
      this.busy = false
      this.runAbort = null
      this.touch()
      this.tick()
    }
  }

  log(text: string): void {
    this.lines.push({ at: Date.now(), text })
    if (this.lines.length > 200) this.lines.splice(0, this.lines.length - 200)
    this.touch()
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private makeContext(): PlaybookContext {
    const bus = this.bus
    const runner = this
    return {
      bus,
      scratch: this.scratch,
      log: (m: string) => runner.log(m),
      provider: (cap: Capability) => bus.provider(cap),
      providers: (cap: Capability) => bus.providers(cap),
      session<T extends DeviceSession = DeviceSession>(id: string): T | undefined {
        return bus.session<T>(id)
      },
      get<T>(key: string): T | undefined {
        return runner.scratch[key] as T | undefined
      },
      set(key: string, value: unknown): void {
        runner.write(key, value)
      },
      isArmed: (id: string, cap: Capability) => bus.node(id)?.armed.includes(cap) ?? false,
      collect: (req: CollectRequest) => runner.collect(req),
      hooks: this.hooks,
    }
  }

  /**
   * Starts the device when it is idle, keeps what passes the filter for the
   * window, then puts it back the way it was found.
   */
  private async collect(req: CollectRequest): Promise<Artifact[]> {
    const node = this.bus.node(req.deviceId)
    if (!node) throw new Error('that device is no longer on the bench')

    const out: Artifact[] = []
    const off = this.bus.onDeviceArtifact(req.deviceId, (a) => {
      if (out.length < req.want && req.accept(a)) out.push(a)
    })

    let started = false
    try {
      if (node.status !== 'streaming') {
        const mode = await this.startFor(req.deviceId, req.cap)
        started = true
        this.log(`${node.label} started in ${mode}`)
      }
      await this.waitUntil(() => out.length >= req.want, req.windowMs)
    } finally {
      off()
      if (started) {
        try {
          await this.bus.stop(req.deviceId)
        } catch {
          // the device may have gone away mid capture. what arrived still counts.
        }
      }
    }
    return out
  }

  private async startFor(id: string, cap: Capability): Promise<string> {
    const modes = MODES_FOR[cap] ?? []
    let last = ''
    for (const mode of modes) {
      try {
        await this.bus.start(id, mode)
        return mode
      } catch (err) {
        last = message(err)
      }
    }
    throw new Error(last || `this device has no start mode for ${CAPABILITY_LABELS[cap]}`)
  }

  private waitUntil(done: () => boolean, windowMs: number): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now()
      const signal = this.runAbort?.signal
      const poll = setInterval(() => {
        if (done() || Date.now() - started >= windowMs || signal?.aborted) {
          clearInterval(poll)
          resolve()
        }
      }, 100)
    })
  }

  private abortRun(): void {
    this.runAbort?.abort()
    this.runAbort = null
  }

  private seedChoice(step: PlaybookStep | undefined): void {
    if (!step?.choices || !step.choiceKey) return
    if (this.scratch[step.choiceKey] !== undefined) return
    const first = step.choices(this.ctx)[0]
    if (first) this.write(step.choiceKey, first.value)
  }

  /** Polls the current step and moves on when it reports itself done. */
  private tick(): void {
    if (!this.playbook || this.busy) {
      this.touch()
      return
    }
    const step = this.steps[this.index]
    if (step) {
      if (this.isComplete(step)) {
        if (!this.announced.has(step.id)) {
          this.announced.add(step.id)
          this.log(`${step.title}: done`)
        }
        const next = this.steps.findIndex((s, i) => i > this.index && !this.isComplete(s))
        if (next !== -1) {
          this.index = next
          this.seedChoice(this.steps[next])
        }
      } else {
        this.seedChoice(step)
      }
    }
    this.touch()
  }

  private signature(): string {
    const done = this.steps.map((s) => (this.isComplete(s) ? '1' : '0')).join('')
    const ready = this.steps.map((s) => (this.readiness(s).ready ? '1' : '0')).join('')
    return [
      this.playbook?.id ?? '',
      this.index,
      done,
      ready,
      this.lines.length,
      this.busy ? '1' : '0',
      this.error ?? '',
      this.scratchVersion,
    ].join('|')
  }

  private touch(): void {
    const sig = this.signature()
    if (sig === this.lastSignature) return
    this.lastSignature = sig
    for (const fn of this.subs) fn()
  }
}

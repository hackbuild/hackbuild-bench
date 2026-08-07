import type { Capability } from '@/core/capabilities'
import type { DeviceBus } from '@/core/bus/DeviceBus'
import type { DeviceSession } from '@/core/drivers/types'
import type { Artifact, DeviceNode } from '@/core/types'

/**
 * A playbook is a job the bench does for you.
 *
 * It names capabilities, never devices, so the same sequence runs across
 * whatever is plugged in: one radio can sniff while another transmits, and a
 * board can move a pin in response. Every step reports its own completion from
 * real state, so the runner never guesses that something worked.
 */

export interface PlaybookChoice {
  value: string | number
  label: string
  /** One short line under the label, for what the choice means. */
  hint?: string
}

export interface PlaybookStep {
  id: string
  title: string
  detail: string
  /** Capabilities this step needs from the bus. All of them. */
  requires: Capability[]
  /** Capabilities where any one provider is enough. */
  requiresAny?: Capability[]
  /** True when the step is done. Polled by the runner. */
  isComplete(ctx: PlaybookContext): boolean
  /** Optional automatic action, run when the user presses the step button. */
  run?(ctx: PlaybookContext): Promise<void>
  /** When set, the step needs this armed before run() is offered. */
  arms?: Capability
  /** The device the arm applies to. Defaults to the first provider. */
  armOn?(ctx: PlaybookContext): string | undefined
  /** The user does something physical, we just wait. */
  manual?: boolean
  /** Button label. */
  actionLabel?: string
  /** A pick the user makes before run(). The value lands under choiceKey. */
  choices?(ctx: PlaybookContext): PlaybookChoice[]
  choiceKey?: string
  /** What the step found, in plain lines, once it has something. */
  summary?(ctx: PlaybookContext): string[]
  /** Bytes the step produced or is about to send, shown as hex. */
  bytes?(ctx: PlaybookContext): Uint8Array | null
}

export interface Playbook {
  id: string
  title: string
  blurb: string
  icon: string
  /** The whole playbook needs these somewhere on the bench. */
  requires: Capability[]
  /** Any one of these is enough for the playbook to be worth opening. */
  requiresAny?: Capability[]
  steps: PlaybookStep[]
}

// ---------------------------------------------------------------------------
// the context a running playbook gets
// ---------------------------------------------------------------------------

/** One artifact collection window over a single device. */
export interface CollectRequest {
  deviceId: string
  /** Decides which start mode the device is put into. */
  cap: Capability
  /** Keep the artifacts that pass. */
  accept(a: Artifact): boolean
  /** Stop early once this many have passed. */
  want: number
  windowMs: number
}

/** A rule a playbook hands to the automations store. */
export interface PlaybookRule {
  trigger: { kind: string; detail: string; deviceId?: string; match?: string }
  condition: { kind: string; detail: string; minGapMs?: number }
  action: { kind: string; detail: string; deviceId?: string }
  /** What the rule does when it fires. */
  perform?: () => Promise<void>
}

/**
 * Effects that live above core. The caller passes them in so playbooks can
 * reach the analysis tool and the automations store without core importing a
 * store.
 */
export interface PlaybookHooks {
  sendToAnalysis(label: string, bytes: Uint8Array): void
  createRule(rule: PlaybookRule): void
}

export interface PlaybookContext {
  bus: DeviceBus
  /** State the playbook accumulates as it runs. */
  scratch: Record<string, unknown>
  log(message: string): void
  provider(cap: Capability): DeviceNode | undefined
  providers(cap: Capability): DeviceNode[]
  session<T extends DeviceSession = DeviceSession>(deviceId: string): T | undefined
  get<T>(key: string): T | undefined
  set(key: string, value: unknown): void
  isArmed(deviceId: string, cap: Capability): boolean
  /** Start a device, keep what it emits for a window, stop it again. */
  collect(req: CollectRequest): Promise<Artifact[]>
  hooks: PlaybookHooks
}

// ---------------------------------------------------------------------------
// extra driver surface playbooks reach for through bus.session()
//
// None of this is part of the adapter contract, so every method is optional
// and every step says plainly when the connected device has no path for it.
// ---------------------------------------------------------------------------

export interface FrameTransmitSession extends DeviceSession {
  transmit?(bytes: Uint8Array, opts?: { centerHz?: number; repeats?: number }): Promise<void>
}

export interface GattCharacteristic {
  uuid: string
  name?: string
  /** read, write, notify, indicate, as the driver reports them. */
  properties: string[]
}

export interface GattService {
  uuid: string
  name?: string
  characteristics: GattCharacteristic[]
}

export interface GattChange {
  service: string
  characteristic: string
  after: Uint8Array
  at: number
}

export interface GattSession extends DeviceSession {
  connectGatt?(target: { address?: string; name?: string }): Promise<{ name?: string }>
  listGatt?(): Promise<GattService[]>
  readGatt?(service: string, characteristic: string): Promise<Uint8Array>
  watchGatt?(ms: number): Promise<GattChange[]>
}

export interface PinDriveSession extends DeviceSession {
  setPin?(pin: number, mode: string, value?: number): Promise<void>
  setPinMode?(pin: number, mode: string): Promise<void>
  writePin?(pin: number, value: number): Promise<void>
  setServo?(pin: number, degrees: number): Promise<void>
}

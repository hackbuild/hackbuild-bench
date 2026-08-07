import { bus } from '@/core/bus/DeviceBus'
import { CAPABILITIES } from '@/core/capabilities'
import type { Artifact } from '@/core/types'
import type { DeviceSession } from '@/core/drivers/types'

/**
 * The action a rule takes when it fires, and the trigger that fires it.
 *
 * Each action config compiles to a real function through buildPerform. There
 * is no label-only action: if the panel offers it, it does something.
 */

export type TriggerType = 'any' | 'packet' | 'line' | 'transcript' | 'reading'

export interface TriggerConfig {
  type: TriggerType
  /** Watch one device, or any device when empty. */
  deviceId?: string
  /** Substring for packet and line triggers, exact word for transcript. */
  match?: string
  /** For a reading trigger: fire when the named reading crosses above this. */
  readingName?: string
  above?: number
}

export interface ConditionConfig {
  /** Milliseconds between fires, 0 for no limit. */
  minGapMs: number
}

export type ActionType = 'log' | 'notify' | 'record' | 'pin' | 'retune'

export interface ActionConfig {
  type: ActionType
  /** The device an action operates on, where it needs one. */
  deviceId?: string
  /** For pin: which pin, and what to do. */
  pin?: number
  pinMode?: 'high' | 'low' | 'pulse'
  /** For retune: the frequency to move a receiver to. */
  hz?: number
  /** For notify and log: the message. Falls back to a summary of the trigger. */
  message?: string
}

/** What an action needs from the outside, injected so this stays Vue-free. */
export interface ActionEnv {
  log(message: string): void
  notify(message: string): void
  setRecording(on: boolean): void
}

type PinSession = DeviceSession & {
  setPinMode(pin: number, mode: string): Promise<void>
  writePin(pin: number, value: number): Promise<void>
}

function describeArtifact(a: Artifact): string {
  if (a.kind === 'packet') return a.summary ?? `${a.proto} packet`
  if (a.kind === 'line') return a.text
  if (a.kind === 'transcript') return a.word
  if (a.kind === 'reading') return `${a.name} ${a.value}`
  return a.kind
}

/**
 * Compiles an action config into a function that runs when the rule fires.
 * The triggering artifact is passed so a message can quote it.
 */
export function buildPerform(
  action: ActionConfig,
  env: ActionEnv,
): (a: Artifact) => Promise<void> {
  switch (action.type) {
    case 'log':
      return async (a) => {
        env.log(action.message || describeArtifact(a))
      }

    case 'notify':
      return async (a) => {
        env.notify(action.message || describeArtifact(a))
      }

    case 'record':
      return async () => {
        env.setRecording(true)
      }

    case 'pin':
      return async () => {
        if (action.deviceId === undefined || action.pin === undefined) {
          throw new Error('this rule has no board or pin set')
        }
        const node = bus.node(action.deviceId)
        if (!node) throw new Error('the action board is not connected')
        if (!node.armed.includes(CAPABILITIES.GPIO_DRIVE)) {
          throw new Error(`arm gpio drive on ${node.label} for this to fire`)
        }
        const session = bus.session<PinSession>(action.deviceId)
        if (!session?.writePin) throw new Error(`${node.label} cannot drive a pin`)
        const pin = action.pin
        if (action.pinMode === 'pulse') {
          await session.setPinMode(pin, 'output')
          await session.writePin(pin, 1)
          setTimeout(() => {
            void session.writePin(pin, 0).catch(() => undefined)
          }, 250)
        } else {
          await session.setPinMode(pin, 'output')
          await session.writePin(pin, action.pinMode === 'high' ? 1 : 0)
        }
      }

    case 'retune':
      return async () => {
        if (action.deviceId === undefined || action.hz === undefined) {
          throw new Error('this rule has no radio or frequency set')
        }
        await bus.configure(action.deviceId, { centerHz: action.hz })
      }

    default:
      return async () => undefined
  }
}

/** Whether a trigger config matches an incoming artifact. */
export function triggerMatches(trigger: TriggerConfig, a: Artifact): boolean {
  if (trigger.deviceId && trigger.deviceId !== a.source) return false

  switch (trigger.type) {
    case 'any':
      return true
    case 'packet':
      if (a.kind !== 'packet') return false
      return !trigger.match || (a.summary ?? '').toLowerCase().includes(trigger.match.toLowerCase())
    case 'line':
      if (a.kind !== 'line') return false
      return !trigger.match || a.text.toLowerCase().includes(trigger.match.toLowerCase())
    case 'transcript':
      if (a.kind !== 'transcript') return false
      return !trigger.match || a.word.toLowerCase() === trigger.match.toLowerCase()
    case 'reading':
      if (a.kind !== 'reading') return false
      if (trigger.readingName && a.name !== trigger.readingName) return false
      return trigger.above === undefined || a.value > trigger.above
    default:
      return false
  }
}

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  any: 'anything seen',
  packet: 'a packet matching',
  line: 'a serial line matching',
  transcript: 'a spoken word',
  reading: 'a reading crossing',
}

export const ACTION_LABELS: Record<ActionType, string> = {
  log: 'write to the log',
  notify: 'show a notification',
  record: 'start recording',
  pin: 'drive a pin',
  retune: 'retune a radio',
}

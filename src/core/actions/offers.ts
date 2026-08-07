import { CAPABILITIES } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import type { DeviceBus } from '@/core/bus/DeviceBus'
import type { Artifact, DeviceNode, PacketRecord } from '@/core/types'

/**
 * What else the bench could do with this thing.
 *
 * An offer is produced by matching an artifact against the capabilities
 * currently on the bus. A captured frame becomes replayable the moment a
 * transmit capable radio is connected, without the panel that captured it
 * knowing anything about transmitting. This is where interoperability lives:
 * add a device that provides a capability and every panel that produces a
 * matching artifact gains the action.
 */

export interface Offer {
  id: string
  /** Button label, lowercase and terse. */
  label: string
  /** One line of what it will do, shown on hover and in the confirm. */
  detail: string
  icon: string
  /** The device that would carry it out, when an offer needs one. */
  target?: DeviceNode
  /** Consequential capability the target needs armed first. */
  arms?: Capability
  /** True when the target has it armed already. */
  armed: boolean
}

export interface OfferContext {
  bus: DeviceBus
  /** Hands bytes to the analysis tool. */
  sendToAnalysis(label: string, bytes: Uint8Array): void
  /** Opens the automations tool with a trigger prefilled. */
  createRule?(sourceId: string, match: string): void
}

function isArmed(node: DeviceNode, cap: Capability): boolean {
  return node.armed.includes(cap)
}

/** Every action the current bench can take on this artifact. */
export function offersFor(artifact: Artifact, ctx: OfferContext): Offer[] {
  const out: Offer[] = []

  const hasBytes =
    (artifact.kind === 'packet' && artifact.bytes.length > 0) || artifact.kind === 'blob'

  if (hasBytes) {
    out.push({
      id: 'analyse',
      label: 'send to analysis',
      detail: 'opens these bytes in the recipe editor and runs magic over them',
      icon: 'wand',
      armed: true,
    })
  }

  if (artifact.kind === 'packet') {
    const packet = artifact as PacketRecord

    for (const node of ctx.bus.providers(CAPABILITIES.TRANSMIT_RF)) {
      out.push({
        id: `replay:${node.id}`,
        label: `replay through ${node.label}`,
        detail:
          'parses the frame, shows you the bytes going out, then sends that parsed frame rather than a blind copy of the capture',
        icon: 'tower-broadcast',
        target: node,
        arms: CAPABILITIES.TRANSMIT_RF,
        armed: isArmed(node, CAPABILITIES.TRANSMIT_RF),
      })
    }

    if (packet.proto === 'ble') {
      for (const node of ctx.bus.providers(CAPABILITIES.CONNECT_GATT)) {
        out.push({
          id: `gatt:${node.id}`,
          label: `connect with ${node.label}`,
          detail:
            'opens a gatt connection to this peripheral and walks its services and characteristics',
          icon: 'bluetooth-b',
          target: node,
          armed: true,
        })
      }
    }

    if (packet.proto === 'meshtastic') {
      for (const node of ctx.bus.providers(CAPABILITIES.MESH_TX)) {
        out.push({
          id: `reply:${node.id}`,
          label: `reply on ${node.label}`,
          detail: 'sends a message back on the same channel this one arrived on',
          icon: 'circle-nodes',
          target: node,
          arms: CAPABILITIES.MESH_TX,
          armed: isArmed(node, CAPABILITIES.MESH_TX),
        })
      }
    }

    for (const node of ctx.bus.providers(CAPABILITIES.GPIO_DRIVE)) {
      out.push({
        id: `trigger:${node.id}`,
        label: `make ${node.label} react`,
        detail: 'builds an automation that fires a pin on this board when this frame is seen again',
        icon: 'bolt',
        target: node,
        arms: CAPABILITIES.GPIO_DRIVE,
        armed: isArmed(node, CAPABILITIES.GPIO_DRIVE),
      })
    }
  }

  if (artifact.kind === 'iq') {
    for (const node of ctx.bus.providers(CAPABILITIES.TRANSMIT_RF)) {
      out.push({
        id: `retransmit:${node.id}`,
        label: `retransmit on ${node.label}`,
        detail:
          'sends this capture back out. run it through the frame parser first if you want to see what you are emitting',
        icon: 'satellite-dish',
        target: node,
        arms: CAPABILITIES.TRANSMIT_RF,
        armed: isArmed(node, CAPABILITIES.TRANSMIT_RF),
      })
    }
  }

  return out
}

/**
 * Offers that would exist if the right hardware were connected, phrased as
 * what to plug in. Shown greyed so the user learns what the bench can do.
 */
export interface MissingOffer {
  label: string
  needs: string
}

const CAPABILITY_EXAMPLES: Partial<Record<Capability, string>> = {
  [CAPABILITIES.TRANSMIT_RF]: 'a transmit capable radio, like a hackrf',
  [CAPABILITIES.CONNECT_GATT]: 'anything that speaks web bluetooth',
  [CAPABILITIES.GPIO_DRIVE]: 'a board running conduyt',
  [CAPABILITIES.MESH_TX]: 'a meshtastic radio',
}

export function missingOffersFor(artifact: Artifact, bus: DeviceBus): MissingOffer[] {
  const out: MissingOffer[] = []
  if (artifact.kind !== 'packet' && artifact.kind !== 'iq') return out

  const wanted: Array<[Capability, string]> = [
    [CAPABILITIES.TRANSMIT_RF, 'replay this'],
    [CAPABILITIES.GPIO_DRIVE, 'make something react to this'],
  ]
  if (artifact.kind === 'packet' && (artifact as PacketRecord).proto === 'ble') {
    wanted.push([CAPABILITIES.CONNECT_GATT, 'connect to this device'])
  }

  for (const [cap, label] of wanted) {
    if (bus.providers(cap).length === 0) {
      out.push({ label, needs: CAPABILITY_EXAMPLES[cap] ?? cap })
    }
  }
  return out
}

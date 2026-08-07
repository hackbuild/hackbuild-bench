/**
 * The capability vocabulary.
 *
 * Every operation a device can perform is one of these strings. Tools declare
 * the capabilities they need and the bus finds a provider. Nothing outside
 * this file may invent a capability string.
 */

export const CAPABILITIES = {
  // observe. free, on by default, no confirm.
  OBSERVE_SPECTRUM: 'observe.spectrum',
  CAPTURE_IQ: 'capture.iq',
  CAPTURE_PACKET: 'capture.packet',
  CAPTURE_LOGIC: 'capture.logic',
  AUDIO_DEMOD: 'audio.demod',
  CONNECT_GATT: 'connect.gatt',
  BUS_READ: 'bus.read',
  DEBUG_READ: 'debug.read',
  SERIAL_CONSOLE: 'serial.console',
  MESH_RX: 'mesh.rx',
  NET_SURVEY: 'net.survey',
  GNSS_FIX: 'gnss.fix',

  // consequential. one confirm to arm.
  TRANSMIT_RF: 'transmit.rf',
  REPLAY_PACKET: 'replay.packet',
  FUZZ_PROTOCOL: 'fuzz.protocol',
  BUS_DRIVE: 'bus.drive',
  DEBUG_WRITE: 'debug.write',
  FLASH_PROGRAM: 'flash.program',
  FLASH_ERASE: 'flash.erase',
  POWER_SOURCE: 'power.source',
  MESH_TX: 'mesh.tx',
  NET_ATTACK: 'net.attack',
  GPIO_DRIVE: 'gpio.drive',
} as const

export type Capability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES]

/**
 * Impact decides whether an operation needs the arm confirm. Observe is free.
 * Consequential can transmit on a band, drive a bus line, or write flash, so
 * it gets one confirm that says what it does.
 */
export type Impact = 'observe' | 'consequential'

const CONSEQUENTIAL = new Set<string>([
  CAPABILITIES.TRANSMIT_RF,
  CAPABILITIES.REPLAY_PACKET,
  CAPABILITIES.FUZZ_PROTOCOL,
  CAPABILITIES.BUS_DRIVE,
  CAPABILITIES.DEBUG_WRITE,
  CAPABILITIES.FLASH_PROGRAM,
  CAPABILITIES.FLASH_ERASE,
  CAPABILITIES.POWER_SOURCE,
  CAPABILITIES.MESH_TX,
  CAPABILITIES.NET_ATTACK,
  CAPABILITIES.GPIO_DRIVE,
])

export function impactOf(cap: Capability): Impact {
  return CONSEQUENTIAL.has(cap) ? 'consequential' : 'observe'
}

/** Short human label for a capability, used on chips and in the arm dialog. */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  [CAPABILITIES.OBSERVE_SPECTRUM]: 'spectrum',
  [CAPABILITIES.CAPTURE_IQ]: 'iq capture',
  [CAPABILITIES.CAPTURE_PACKET]: 'packet capture',
  [CAPABILITIES.CAPTURE_LOGIC]: 'logic capture',
  [CAPABILITIES.AUDIO_DEMOD]: 'audio demod',
  [CAPABILITIES.CONNECT_GATT]: 'gatt',
  [CAPABILITIES.BUS_READ]: 'bus read',
  [CAPABILITIES.DEBUG_READ]: 'debug read',
  [CAPABILITIES.SERIAL_CONSOLE]: 'serial console',
  [CAPABILITIES.MESH_RX]: 'mesh rx',
  [CAPABILITIES.NET_SURVEY]: 'wifi survey',
  [CAPABILITIES.GNSS_FIX]: 'gnss',
  [CAPABILITIES.TRANSMIT_RF]: 'rf transmit',
  [CAPABILITIES.REPLAY_PACKET]: 'replay',
  [CAPABILITIES.FUZZ_PROTOCOL]: 'fuzz',
  [CAPABILITIES.BUS_DRIVE]: 'bus drive',
  [CAPABILITIES.DEBUG_WRITE]: 'debug write',
  [CAPABILITIES.FLASH_PROGRAM]: 'flash write',
  [CAPABILITIES.FLASH_ERASE]: 'flash erase',
  [CAPABILITIES.POWER_SOURCE]: 'power out',
  [CAPABILITIES.MESH_TX]: 'mesh tx',
  [CAPABILITIES.NET_ATTACK]: 'wifi active',
  [CAPABILITIES.GPIO_DRIVE]: 'gpio drive',
}

/**
 * What the arm confirm tells the user. Plain information about what the action
 * does and what to watch for. No warning tone, no lockout.
 */
export const ARM_NOTES: Partial<Record<Capability, string>> = {
  [CAPABILITIES.TRANSMIT_RF]:
    'this puts energy on the air at the tuned frequency. check the band is one you are allowed to transmit on, and that an antenna is attached so the amplifier is not driving an open port.',
  [CAPABILITIES.REPLAY_PACKET]:
    'this re-sends captured frames. the frame is parsed and shown before it goes out so you can see what you are emitting.',
  [CAPABILITIES.FUZZ_PROTOCOL]:
    'this sends malformed frames at the target. run it against hardware you own, since a crashed device may need a power cycle.',
  [CAPABILITIES.BUS_DRIVE]:
    'this stops high impedance and drives the bus lines. confirm the target voltage matches before enabling, since driving 5 V into a 3.3 V part damages it.',
  [CAPABILITIES.DEBUG_WRITE]:
    'this writes target memory over the debug port. a bad write can halt or brick the target until it is reflashed.',
  [CAPABILITIES.FLASH_PROGRAM]:
    'this writes firmware. read and save the current image first if you want a way back.',
  [CAPABILITIES.FLASH_ERASE]:
    'this erases flash. the existing image is gone unless you already have a copy.',
  [CAPABILITIES.POWER_SOURCE]:
    'this sources power to the target from the probe. check the target is not already externally powered.',
  [CAPABILITIES.MESH_TX]:
    'this transmits on the mesh. messages are relayed by other nodes and are not private.',
  [CAPABILITIES.NET_ATTACK]:
    'this moves the pineapple from listening to acting on nearby clients. use it on a network you run.',
  [CAPABILITIES.GPIO_DRIVE]:
    'this drives board pins as outputs. check nothing on the pin is already driving it the other way.',
}

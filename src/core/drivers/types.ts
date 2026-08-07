import type { Capability } from '../capabilities'
import type { ArtifactDraft, DeviceDescriptor, TransportKind } from '../types'

/**
 * The adapter contract. Every device implements exactly this and nothing more.
 *
 * A driver knows how to talk to one family of hardware. It does not know about
 * Vue, the bus, stores, or any other driver. It reports what it can do and
 * emits typed artifacts.
 */

export interface DriverContext {
  /** Push a typed artifact onto the bus. */
  emit(artifact: ArtifactDraft): void
  /** Human readable line for the device log panel. */
  log(message: string): void
  /** Report identity read off the hardware: serial, firmware, tuner chip. */
  setInfo(info: Record<string, string>): void
  /** Ask whether a consequential capability has been armed by the user. */
  isArmed(cap: Capability): boolean
  /** Cancelled when the device stops or closes. */
  signal: AbortSignal
}

export interface DeviceSession {
  /**
   * Capabilities this specific unit turned out to have, after probing. An
   * RTL-SDR with an E4000 tuner reports a different range than an R820T.
   */
  getCapabilities(): Capability[]

  /** Identity read off the hardware. Merged into node.info. */
  getInfo(): Record<string, string>

  /** Apply parameter changes. Called on every knob move, so keep it cheap. */
  configure(params: Record<string, number>): Promise<void>

  /** Begin streaming. Emits artifacts through the context until stop. */
  start(mode: string): Promise<void>

  /** Halt streaming. The device stays open. */
  stop(): Promise<void>

  /**
   * Return the hardware to a state that is safe to walk away from: receive
   * only, amplifiers off, bus lines high impedance, outputs undriven.
   */
  resetToSafeState(): Promise<void>

  /** Release the transport. */
  close(): Promise<void>

  /** Called periodically. Return false when the device has gone away. */
  health(): Promise<boolean>
}

export interface DeviceDriver {
  descriptor: DeviceDescriptor

  /**
   * Which transports this driver can actually use in this browser right now.
   * Defaults to descriptor.transports when not implemented.
   */
  availableTransports?(): TransportKind[]

  /**
   * Prompt the user to pick a device. Must be called from a user gesture.
   * Returns null when the user dismisses the picker.
   *
   * `fields` carries the values the connect dialog collected for the
   * descriptor's accessFields. Drivers with a browser picker ignore it.
   */
  requestAccess(
    transport: TransportKind,
    fields?: Record<string, string>,
  ): Promise<DeviceHandle | null>

  /** Devices the user has already granted, reconnectable without a prompt. */
  enumerate?(): Promise<DeviceHandle[]>

  /** Open a handle and produce a live session. */
  open(handle: DeviceHandle, ctx: DriverContext): Promise<DeviceSession>
}

/**
 * An opaque reference to a chosen but unopened device. Carries whatever the
 * driver needs to open it, plus the identity the connect UI shows.
 */
export interface DeviceHandle {
  kind: string
  transport: TransportKind
  /** Stable per physical unit where the transport gives us a serial. */
  uid: string
  label: string
  /** Driver private. The bus never looks inside this. */
  raw: unknown
}

/** The modes a driver's start() accepts, declared for the UI. */
export interface StartMode {
  id: string
  label: string
  requires: Capability
}

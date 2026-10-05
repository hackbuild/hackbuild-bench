import type { BitBuffer } from './bitbuffer'

/** How a protocol's bits sit in the pulse train. */
export type Modulation =
  | 'ook_pcm'
  | 'ook_ppm'
  | 'ook_pwm'
  | 'ook_manchester'
  | 'fsk_pcm'
  | 'fsk_pwm'
  | 'fsk_manchester'

export type FieldValue = number | string

/** One decoded transmission, with fields named the way rtl_433 names them. */
export interface IsmMessage {
  model: string
  fields: Record<string, FieldValue>
  /** The checked payload, when the protocol has one worth keeping. */
  bytes?: Uint8Array
}

/**
 * A protocol decoder. Timings are in microseconds, as rtl_433 states them.
 *
 * `decode` gets one slicer result and returns how many messages it emitted.
 * Zero or less means nothing usable was in the bits.
 */
export interface IsmProtocol {
  /** Stable key, also the rtl_433 source file it came from. */
  id: string
  name: string
  modulation: Modulation
  shortUs: number
  longUs: number
  resetUs: number
  gapUs?: number
  syncUs?: number
  toleranceUs?: number
  /** Lower runs first. A higher tier only runs when nothing lower decoded. */
  priority?: number
  decode(bits: BitBuffer, emit: (m: IsmMessage) => void): number
}

export const PD_MAX_PULSES = 1200

/** Pulse and gap widths in samples, as the detector hands them to the slicers. */
export interface PulseData {
  pulse: Int32Array
  gap: Int32Array
  num: number
  sampleRate: number
  /** Absolute sample index of the first pulse. */
  offset: number
  ookLow: number
  ookHigh: number
  fskF1: number
  fskF2: number
}

export function newPulseData(): PulseData {
  return {
    pulse: new Int32Array(PD_MAX_PULSES),
    gap: new Int32Array(PD_MAX_PULSES),
    num: 0,
    sampleRate: 0,
    offset: 0,
    ookLow: 0,
    ookHigh: 0,
    fskF1: 0,
    fskF2: 0,
  }
}

export function clearPulseData(p: PulseData): void {
  p.pulse.fill(0)
  p.gap.fill(0)
  p.num = 0
  p.offset = 0
  p.ookLow = 0
  p.ookHigh = 0
  p.fskF1 = 0
  p.fskF2 = 0
}

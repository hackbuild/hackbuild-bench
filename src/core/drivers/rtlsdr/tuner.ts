/**
 * The contract every tuner chip behind the RTL2832U implements.
 *
 * The driver opens the i2c gate before calling any method here and closes it
 * afterwards. Gains are in tenths of a dB, the unit librtlsdr uses, so a port
 * can be checked against the C value for value.
 */

import type { RtlCom } from './rtlcom'

/** What a tuner may ask of the demodulator chip besides its own registers. */
export interface TunerHost {
  com: RtlCom
  /** Corrected crystal the tuner runs from, in Hz. */
  xtal: number
  setGpioOutput(bit: number): Promise<void>
  setGpioBit(bit: number, on: boolean): Promise<void>
}

export interface Tuner {
  /** Chip name for the device info, lowercase. */
  readonly name: string
  /**
   * True when the tuner hands the demod a low if, as the R82xx family does.
   * False for zero if tuners, which librtlsdr runs with the demod if at 0,
   * zero if mode on, and both adc inputs enabled.
   */
  readonly lowIf: boolean
  /** Tuning ranges in Hz the chip reaches, lowest first. Gaps between are unreachable. */
  readonly ranges: Array<[number, number]>
  /** Manual gain steps in tenths of a dB, as librtlsdr lists them. Empty when there is no gain control. */
  readonly gains: number[]
  /**
   * False when handing gain back to the tuner does nothing, as on the FC0012,
   * whose librtlsdr gain mode call is empty. The gain knob then has no auto.
   */
  readonly agc: boolean
  /** False when the pll did not report lock at the last tune. */
  pllLock: boolean

  /** New corrected crystal, after a ppm change. Takes effect at the next tune. */
  setXtal(hz: number): void
  init(): Promise<void>
  /** Returns the frequency actually reached in Hz, or null when the chip cannot tune there. */
  setFrequency(hz: number): Promise<number | null>
  /**
   * Fits the if filter to a bandwidth in Hz. Returns the if the demod must
   * now use, or null when this tuner leaves the if where it was.
   */
  setBandwidth(bw: number): Promise<number | null>
  /** Tenths of a dB with manual gain, or null to hand gain to the tuner's agc. */
  setGain(tenths: number | null): Promise<void>
  /** Puts the chip in standby. Safe to call on a chip that never finished init. */
  shutdown(): Promise<void>
}

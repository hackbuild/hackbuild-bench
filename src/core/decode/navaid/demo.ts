/**
 * A VOR or ILS transmitter at complex baseband, for the demo and the tests.
 *
 * VOR: a carrier amplitude modulated by the 30 Hz variable (its phase set by
 * the radial), by the 9960 Hz subcarrier which is itself FM modulated by the
 * 30 Hz reference, and by the 1020 Hz morse ident. ILS: the carrier modulated
 * by 90 Hz and 150 Hz at depths that set the DDM.
 */

import { textToMorse } from './morse'

export const DEMO_VOR_HZ = 115_600_000

interface VorOptions {
  /** The radial the receiver should read back, degrees. */
  radial: number
  ident: string
}

interface IlsOptions {
  /** Difference in depth of modulation, positive means the 90 Hz tone leads. */
  ddm: number
  ident: string
}

const SUBCARRIER = 9960
const SUB_DEVIATION = 480

export class VorDemoSource {
  private t = 0
  private readonly morse: string

  constructor(private readonly opts: VorOptions) {
    this.morse = textToMorse(opts.ident)
  }

  read(ms: number, centerHz: number, rate: number): Float32Array {
    const n = Math.max(1, Math.round((rate * ms) / 1000))
    const out = new Float32Array(n * 2)
    const off = DEMO_VOR_HZ - centerHz
    const radial = (this.opts.radial * Math.PI) / 180
    for (let k = 0; k < n; k++) {
      const t = this.t + k / rate
      // reference 30 Hz as fm on the 9960 subcarrier.
      const subPhase = 2 * Math.PI * SUBCARRIER * t + (SUB_DEVIATION / 30) * Math.sin(2 * Math.PI * 30 * t)
      const ref = Math.cos(subPhase)
      // variable 30 Hz, shifted by the radial.
      const variable = Math.cos(2 * Math.PI * 30 * t - radial)
      const ident = morseGate(this.morse, t) ? Math.cos(2 * Math.PI * 1020 * t) : 0
      const am = 1 + 0.3 * variable + 0.3 * ref + 0.1 * ident
      const ph = 2 * Math.PI * off * t
      out[2 * k] = am * Math.cos(ph) * 0.3
      out[2 * k + 1] = am * Math.sin(ph) * 0.3
    }
    this.t += n / rate
    return out
  }
}

export class IlsDemoSource {
  private t = 0
  private readonly morse: string

  constructor(private readonly opts: IlsOptions) {
    this.morse = textToMorse(opts.ident)
  }

  read(ms: number, centerHz: number, rate: number): Float32Array {
    const n = Math.max(1, Math.round((rate * ms) / 1000))
    const out = new Float32Array(n * 2)
    const off = DEMO_VOR_HZ - centerHz
    const d90 = 0.2 + this.opts.ddm / 2
    const d150 = 0.2 - this.opts.ddm / 2
    for (let k = 0; k < n; k++) {
      const t = this.t + k / rate
      const ident = morseGate(this.morse, t) ? Math.cos(2 * Math.PI * 1020 * t) : 0
      const am = 1 + d90 * Math.cos(2 * Math.PI * 90 * t) + d150 * Math.cos(2 * Math.PI * 150 * t) + 0.1 * ident
      const ph = 2 * Math.PI * off * t
      out[2 * k] = am * Math.cos(ph) * 0.3
      out[2 * k + 1] = am * Math.sin(ph) * 0.3
    }
    this.t += n / rate
    return out
  }
}

/** True while the morse ident keys on at time t, at 7 words per minute. */
function morseGate(morse: string, t: number): boolean {
  const dot = 0.08
  // one ident every 4 seconds.
  let at = t % 4
  for (const sym of morse) {
    if (sym === ' ') {
      at -= 2 * dot
    } else {
      const len = sym === '-' ? 3 * dot : dot
      if (at >= 0 && at < len) return true
      at -= len + dot
    }
    if (at < 0) return false
  }
  return false
}

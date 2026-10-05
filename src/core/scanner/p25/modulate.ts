import { LEVEL } from './framing'

/**
 * A P25 phase 1 transmitter at complex baseband, for tests and demo mode.
 *
 * C4FM is frequency modulation: each symbol's level, shaped by a raised
 * cosine, sets the deviation, 600 Hz a level unit. LSM, the simulcast
 * flavour, carries the same symbols as phase steps of 45 degrees a level unit
 * through a root raised cosine. A C4FM receiver that reads the phase change
 * across each symbol hears both, which is what the receiver here does.
 */

export type P25Modulation = 'c4fm' | 'lsm'

const SYMBOL_RATE = 4800
const ALPHA = 0.2
const SPAN = 8

function raisedCosine(t: number, root: boolean): number {
  const a = ALPHA
  if (!root) {
    const den = 1 - (2 * a * t) ** 2
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
    return Math.abs(den) < 1e-9 ? (Math.PI / 4) * sinc : (sinc * Math.cos(Math.PI * a * t)) / den
  }
  if (t === 0) return 1 - a + (4 * a) / Math.PI
  if (Math.abs(Math.abs(4 * a * t) - 1) < 1e-9) {
    return (a / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * a)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * a)))
  }
  const num = Math.sin(Math.PI * t * (1 - a)) + 4 * a * t * Math.cos(Math.PI * t * (1 + a))
  return num / (Math.PI * t * (1 - (4 * a * t) ** 2))
}

export interface ModulateOptions {
  /** Output sample rate, a whole multiple of 4800. */
  rate?: number
  /** A second transmitter heard this many seconds later at this gain, as on a simulcast. */
  echoS?: number
  echoGain?: number
}

/** Dibits in, interleaved I and Q out at the rate asked for. */
export function modulateP25(dibits: number[], mode: P25Modulation, opts: ModulateOptions = {}): Float32Array {
  const rate = opts.rate ?? 48000
  const sps = Math.round(rate / SYMBOL_RATE)
  const n = dibits.length * sps
  const half = (SPAN * sps) / 2
  const taps = new Float32Array(SPAN * sps + 1)
  for (let i = 0; i < taps.length; i++) taps[i] = raisedCosine((i - half) / sps, mode === 'lsm')

  const out = new Float32Array(n * 2)
  if (mode === 'c4fm') {
    // shaped levels set the instantaneous frequency.
    const freq = new Float32Array(n)
    dibits.forEach((d, k) => {
      const at = k * sps
      for (let i = 0; i < taps.length; i++) {
        const j = at + i - half
        if (j >= 0 && j < n) freq[j] += LEVEL[d] * taps[i]
      }
    })
    let ph = 0
    for (let j = 0; j < n; j++) {
      ph += (2 * Math.PI * 600 * freq[j]) / rate
      out[2 * j] = Math.cos(ph)
      out[2 * j + 1] = Math.sin(ph)
    }
  } else {
    // each symbol is a phase step, and the steps are shaped as points.
    let ph = 0
    const norm = 1 / taps[half]
    dibits.forEach((d, k) => {
      ph += (LEVEL[d] * Math.PI) / 4
      const c = Math.cos(ph) * norm
      const s = Math.sin(ph) * norm
      const at = k * sps
      for (let i = 0; i < taps.length; i++) {
        const j = at + i - half
        if (j >= 0 && j < n) {
          out[2 * j] += c * taps[i]
          out[2 * j + 1] += s * taps[i]
        }
      }
    })
  }

  const echo = Math.round((opts.echoS ?? 0) * rate)
  if (echo > 0 && opts.echoGain) {
    const g = opts.echoGain
    // the second site's carrier arrives at an arbitrary phase.
    const c = Math.cos(1.1)
    const s = Math.sin(1.1)
    for (let j = n - 1; j >= echo; j--) {
      const i = out[2 * (j - echo)]
      const q = out[2 * (j - echo) + 1]
      out[2 * j] += g * (i * c - q * s)
      out[2 * j + 1] += g * (i * s + q * c)
    }
  }
  return out
}

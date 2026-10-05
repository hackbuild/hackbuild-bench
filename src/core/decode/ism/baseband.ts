/**
 * Envelope and instantaneous frequency of 8 bit IQ, in rtl_433's fixed point.
 *
 * A port of baseband.c (GPL-2.0-or-later, Benjamin Larsson, Tommy
 * Vestermark). The arithmetic is integer on purpose: the pulse detector's
 * thresholds are tuned to these scales, and matching them is what lets a
 * recording decode here the way it decodes under rtl_433.
 */

const SQUARES = new Uint16Array(256)
for (let i = 0; i < 256; i++) SQUARES[i] = (127 - i) * (127 - i)

const F_SCALE = 15
const fix = (x: number): number => Math.trunc(x * (1 << F_SCALE))

/** One pole low pass on the envelope, butter(1, 0.05). */
const LP_A1 = fix(0.85408) >> 1
const LP_B0 = fix(0.07296) >> 1

const I_PI_4 = Math.trunc(32767 / 4)
const I_3_PI_4 = Math.trunc((3 * 32767) / 4)

function atan2i16(y: number, x: number): number {
  if (!x && !y) return 0
  const ay = Math.abs(y)
  let angle: number
  if (x >= 0) {
    const d = ay + x || 1
    angle = I_PI_4 - Math.trunc((I_PI_4 * (x - ay)) / d)
  } else {
    const d = ay - x || 1
    angle = I_3_PI_4 - Math.trunc((I_PI_4 * (x + ay)) / d)
  }
  return y < 0 ? -angle : angle
}

export class Baseband {
  private lpX = 0
  private lpY = 0
  private fmXr = 0
  private fmXi = 0
  private fmXf = 0
  private fmYf = 0
  private fmRate = 0
  private fmLowPass = 0
  private alp1 = 0
  private blp0 = 0

  reset(): void {
    this.lpX = this.lpY = 0
    this.fmXr = this.fmXi = this.fmXf = this.fmYf = 0
    this.fmRate = 0
  }

  /**
   * Squared magnitude, 16384 at full scale, through the low pass.
   * Returns the mean power of the block in dB full scale.
   */
  envelope(iq: Uint8Array, n: number, out: Int16Array, tmp: Uint16Array): number {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const v = SQUARES[iq[2 * i]] + SQUARES[iq[2 * i + 1]]
      tmp[i] = v
      sum += v
    }
    if (n < 1) return -42.1442
    let y = (LP_A1 * this.lpY + LP_B0 * (tmp[0] + this.lpX)) >> (F_SCALE - 1)
    out[0] = y
    for (let i = 1; i < n; i++) {
      y = (LP_A1 * y + LP_B0 * (tmp[i] + tmp[i - 1])) >> (F_SCALE - 1)
      out[i] = y
    }
    this.lpX = tmp[n - 1]
    this.lpY = out[n - 1]
    const mean = sum / n
    return mean >= 1 ? 10 * Math.log10(mean) - 42.1442 : -42.1442
  }

  /** Phase difference per sample, pi at 32767, through a low pass at `lowPass` of the rate. */
  fm(iq: Uint8Array, n: number, out: Int16Array, rate: number, lowPass: number): void {
    if (rate !== this.fmRate || lowPass !== this.fmLowPass) {
      const ita = 1 / Math.tan((Math.PI / 2) * lowPass)
      const gain = 1 / (1 + ita) / 2
      this.alp1 = fix((ita - 1) * gain)
      this.blp0 = fix(gain)
      this.fmRate = rate
      this.fmLowPass = lowPass
    }
    const a1 = this.alp1
    const b0 = this.blp0
    let x0r = this.fmXr
    let x0i = this.fmXi
    let x0f = this.fmXf
    let y0f = this.fmYf
    for (let i = 0; i < n; i++) {
      const x1r = x0r
      const x1i = x0i
      const x1f = x0f
      x0r = iq[2 * i] - 128
      x0i = iq[2 * i + 1] - 128
      const pr = x0r * x1r + x0i * x1i
      const pi = x0i * x1r - x0r * x1i
      x0f = (atan2i16(pi, pr) << 16) >> 16
      y0f = (((a1 * y0f + b0 * (x0f + x1f)) >> (F_SCALE - 1)) << 16) >> 16
      out[i] = y0f
    }
    this.fmXr = x0r
    this.fmXi = x0i
    this.fmXf = x0f
    this.fmYf = y0f
  }
}

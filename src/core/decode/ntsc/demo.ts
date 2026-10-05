import { LINE_HZ } from './index'

/**
 * An analog NTSC transmitter for demo mode and for tests: a test card with
 * a box that moves, on a carrier with negative amplitude modulation, sent
 * as both sidebands. Every sync, equalising pulse and broad pulse is where
 * the standard puts it.
 */
export const DEMO_ATV_HZ = 421_250_000

const H = 1 / LINE_HZ

/** The level of the test card at a point, in ire. */
export function testCard(row: number, col: number, t: number): number {
  // row 0 to 479, col 0 to 1.
  if (row < 160) return Math.floor(col * 8) * (100 / 7)
  if (row < 320) {
    const boxX = 0.5 + 0.35 * Math.sin(t * 1.6)
    if (Math.abs(col - boxX) < 0.08 && Math.abs(row - 240) < 50) return 100
    const check = (Math.floor(col * 16) + Math.floor(row / 20)) % 2
    return check ? 60 : 20
  }
  const dx = (col - 0.5) * 1.33
  const dy = (row - 400) / 480
  const r = Math.hypot(dx, dy)
  return Math.abs(r - 0.12) < 0.012 ? 100 : 10
}

/** Composite level in ire at a time from the start of a frame. Sync is -40. */
export function composite(tf: number, t: number, card = testCard): number {
  const half = Math.floor(tf / (H / 2)) % 1050
  const inHalf = tf - half * (H / 2)
  const eq = (h: number) =>
    (h >= 0 && h <= 5) || (h >= 12 && h <= 17) || (h >= 525 && h <= 530) || (h >= 537 && h <= 542)
  const broad = (h: number) => (h >= 6 && h <= 11) || (h >= 531 && h <= 536)
  if (eq(half)) return inHalf < 2.3e-6 ? -40 : 0
  if (broad(half)) return inHalf < H / 2 - 4.7e-6 ? -40 : 0
  // a normal line starts on an even half line.
  const line = Math.floor(half / 2) + 1
  const x = tf - (line - 1) * H
  if (x < 4.7e-6) return -40
  if (x < 10.9e-6 || x > 62.06e-6) return 0
  let row: number
  if (line >= 22 && line <= 262) row = 2 * (line - 22)
  else if (line >= 285 && line <= 525) row = 2 * (line - 285) + 1
  else return 0
  if (row >= 480) return 0
  return 7.5 + 0.925 * card(row, (x - 10.9e-6) / 51.16e-6, t)
}

/** Carrier amplitude for a level in ire: sync tips full, white an eighth. */
export function amplitude(ire: number): number {
  return ire <= 0 ? 0.75 - (ire / 40) * 0.25 : 0.75 - (ire / 100) * 0.625
}

export class NtscDemoSource {
  private t = 0
  private readonly drift: number

  constructor(
    private readonly carrierHz = DEMO_ATV_HZ,
    driftHz = 2_500,
  ) {
    this.drift = driftHz
  }

  read(ms: number, centerHz: number, rate: number): Float32Array {
    const count = Math.max(1, Math.round((rate * ms) / 1000))
    const out = new Float32Array(count * 2)
    const off = this.carrierHz + this.drift - centerHz
    const frameS = 525 * H
    const level = 0.3
    for (let k = 0; k < count; k++) {
      const t = this.t + k / rate
      const tf = t % frameS
      const a = Math.abs(off) < rate / 2 ? amplitude(composite(tf, t)) * level : 0
      const ph = 2 * Math.PI * off * t
      out[2 * k] = a * Math.cos(ph) + 0.02 * (Math.random() - 0.5)
      out[2 * k + 1] = a * Math.sin(ph) + 0.02 * (Math.random() - 0.5)
    }
    this.t += count / rate
    return out
  }
}

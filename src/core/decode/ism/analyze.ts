/**
 * A first look at a burst nothing decoded: which widths it is built from.
 *
 * Widths within a fifth of each other share a cluster, the way rtl_433's
 * pulse analyzer groups them. Two pulse widths and one gap width suggest
 * PWM, one pulse width and two gaps suggest PPM.
 */

export interface WidthCluster {
  us: number
  count: number
}

export function clusterWidths(widths: number[], tolerance = 0.2, max = 4): WidthCluster[] {
  const sorted = widths.filter((w) => w > 0).sort((a, b) => a - b)
  const out: Array<{ sum: number; count: number; lo: number }> = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && w <= last.lo * (1 + tolerance) + 8) {
      last.sum += w
      last.count++
    } else {
      out.push({ sum: w, count: 1, lo: w })
    }
  }
  return out
    .map((c) => ({ us: Math.round(c.sum / c.count), count: c.count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .sort((a, b) => a.us - b.us)
}

export type CodingGuess = 'pwm' | 'ppm' | 'manchester or nrz' | 'unclear'

export function guessCoding(pulses: WidthCluster[], gaps: WidthCluster[]): CodingGuess {
  const p = pulses.filter((c) => c.count > 2)
  const g = gaps.filter((c) => c.count > 2)
  const double = (c: WidthCluster[]): boolean => c.length === 2 && c[1].us / c[0].us > 1.7 && c[1].us / c[0].us < 2.3
  if (p.length === 1 && g.length >= 2) return 'ppm'
  if (double(p) && double(g)) return 'manchester or nrz'
  if (p.length >= 2) return 'pwm'
  return 'unclear'
}

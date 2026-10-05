/**
 * Waterfall and spectrum colour maps.
 *
 * A level maps to a colour through a 256 entry lookup, built once per map.
 * The design system's own maps run from the void, so the noise floor stays
 * dark and a carrier reads as the signal. Kerf is the house map: it climbs
 * through indigo and violet to the pink, then burns through amber to paper,
 * so weak signals are cool and strong ones hot with the pink in between.
 */

export type PaletteName = 'kerf' | 'turbo' | 'goo' | 'slime' | 'mono'

type Stop = [at: number, r: number, g: number, b: number]

const STOPS: Record<PaletteName, Stop[]> = {
  kerf: [
    [0, 10, 10, 10],
    [0.16, 28, 10, 62],
    [0.36, 96, 22, 146],
    [0.56, 254, 3, 134],
    [0.76, 255, 112, 64],
    [0.9, 255, 200, 64],
    [1, 245, 240, 230],
  ],
  turbo: [
    [0, 48, 18, 59],
    [0.13, 70, 107, 227],
    [0.25, 40, 188, 235],
    [0.38, 50, 241, 152],
    [0.5, 164, 252, 60],
    [0.63, 237, 208, 58],
    [0.75, 251, 128, 34],
    [0.88, 210, 49, 5],
    [1, 122, 4, 3],
  ],
  goo: [
    [0, 10, 6, 20],
    [0.5, 120, 20, 140],
    [1, 255, 180, 60],
  ],
  slime: [
    [0, 8, 12, 8],
    [0.5, 46, 120, 30],
    [1, 166, 226, 46],
  ],
  mono: [
    [0, 10, 10, 10],
    [1, 245, 240, 230],
  ],
}

export const PALETTES: Array<{ name: PaletteName; label: string }> = [
  { name: 'kerf', label: 'kerf' },
  { name: 'turbo', label: 'turbo' },
  { name: 'goo', label: 'goo' },
  { name: 'slime', label: 'slime' },
  { name: 'mono', label: 'mono' },
]

const built = new Map<PaletteName, Uint8ClampedArray>()

/** Red, green and blue for each of 256 levels, interleaved. */
export function paletteLut(name: PaletteName): Uint8ClampedArray {
  const have = built.get(name)
  if (have) return have
  const stops = STOPS[name] ?? STOPS.kerf
  const out = new Uint8ClampedArray(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    let k = 1
    while (k < stops.length - 1 && stops[k][0] < t) k++
    const a = stops[k - 1]
    const b = stops[k]
    const f = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0
    out[i * 3] = a[1] + (b[1] - a[1]) * f
    out[i * 3 + 1] = a[2] + (b[2] - a[2]) * f
    out[i * 3 + 2] = a[3] + (b[3] - a[3]) * f
  }
  built.set(name, out)
  return out
}

/** The lookup index for a level already mapped onto 0 to 1. */
export function lutIndex(level: number): number {
  return level <= 0 ? 0 : level >= 1 ? 255 : (level * 255) | 0
}

/** A css colour for a level, for drawing a fill that matches the waterfall. */
export function paletteCss(lut: Uint8ClampedArray, level: number, alpha = 1): string {
  const i = lutIndex(level) * 3
  return `rgba(${lut[i]}, ${lut[i + 1]}, ${lut[i + 2]}, ${alpha})`
}

export function isPalette(name: string): name is PaletteName {
  return name in STOPS
}

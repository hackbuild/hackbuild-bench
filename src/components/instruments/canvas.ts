/**
 * Canvas plumbing shared by the instrument screens.
 *
 * Colours and faces are read off the live element so the tokens stay the only
 * source of design values, since a canvas cannot take a CSS class.
 */

export interface ScreenTokens {
  pink: string
  slime: string
  paper: string
  dim: string
  screen: string
  readout: string
}

/** Reads the token values in scope at `el`. Call again after a theme change. */
export function readTokens(el: Element): ScreenTokens {
  const s = getComputedStyle(el)
  const get = (name: string): string => s.getPropertyValue(name).trim()
  return {
    pink: get('--hb-pink'),
    slime: get('--hb-slime'),
    paper: get('--hb-paper'),
    dim: get('--hb-lit-dim'),
    screen: get('--hb-void'),
    readout: get('--hb-readout'),
  }
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export interface Screen {
  ctx: CanvasRenderingContext2D
  /** Drawing width and height in the units the transform was set up for. */
  w: number
  h: number
  dpr: number
  /** True when the backing store was reallocated, which clears the canvas. */
  resized: boolean
}

/**
 * Sizes the backing store to the element and returns a drawing context.
 *
 * With `scale` the transform is in CSS pixels, which is what a trace wants.
 * Without it the transform is identity and `w`/`h` are device pixels, which is
 * what a row-by-row blit wants. Ratio is capped at 2 so a waterfall on a 3x
 * display does not blit nine times the pixels.
 */
export function fitCanvas(canvas: HTMLCanvasElement, scale: boolean): Screen | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const cw = Math.max(1, Math.round(canvas.clientWidth))
  const ch = Math.max(1, Math.round(canvas.clientHeight))
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const dw = Math.max(1, Math.round(cw * dpr))
  const dh = Math.max(1, Math.round(ch * dpr))
  let resized = false
  if (canvas.width !== dw || canvas.height !== dh) {
    canvas.width = dw
    canvas.height = dh
    resized = true
  }
  if (scale) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    return { ctx, w: cw, h: ch, dpr, resized }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  return { ctx, w: dw, h: dh, dpr, resized }
}

/** Waterfall colormap: black to blue to green to yellow to white. */
export function heat(v: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, v))
  return [
    Math.min(255, t * 3 * 255) | 0,
    Math.max(0, (t - 0.35) * 2.2 * 255) | 0,
    (t < 0.5 ? t * 2 * 160 : (1 - t) * 2 * 230) | 0,
  ]
}

/** Maps a dB magnitude onto 0 to 1 across the display window. */
export function normalise(db: number, minDb: number, maxDb: number): number {
  const span = maxDb - minDb
  if (!(span > 0) || !Number.isFinite(db)) return 0
  return Math.max(0, Math.min(1, (db - minDb) / span))
}

/** Value of the placeholder spectrum at x, used until hardware is streaming. */
export function demoLevel(x: number, w: number, phase: number): number {
  let v = 0.12 + 0.07 * Math.random()
  const peaks = [0.3, 0.52, 0.76]
  for (let i = 0; i < peaks.length; i++) {
    const c = peaks[i] * w
    const width = 14 + i * 5
    v += 0.9 * Math.exp(-((x - c) * (x - c)) / (2 * width * width)) * (0.6 + 0.4 * Math.sin(phase + i))
  }
  return v
}

/**
 * Tracks a display window that follows the data.
 *
 * Signal levels differ by orders of magnitude between an rtl-sdr, a hackrf,
 * and a synthetic source, so a fixed dB window either clips or washes out. The
 * floor comes from a low percentile of the frame and the ceiling from its
 * peak, both smoothed so the picture does not flicker frame to frame.
 */
export class AutoRange {
  private floor: number | null = null
  private ceil: number | null = null
  private readonly alpha: number

  constructor(alpha = 0.12) {
    this.alpha = alpha
  }

  /** Feeds a frame and returns the window to draw it in. */
  update(bins: Float32Array): { minDb: number; maxDb: number } {
    if (!bins.length) return { minDb: this.floor ?? -100, maxDb: this.ceil ?? -10 }

    // a strided sample is enough to find the noise floor and costs far less
    // than sorting every bin on every frame.
    const stride = Math.max(1, Math.floor(bins.length / 256))
    const sample: number[] = []
    let peak = -Infinity
    for (let i = 0; i < bins.length; i += stride) {
      const v = bins[i]
      if (!Number.isFinite(v)) continue
      sample.push(v)
      if (v > peak) peak = v
    }
    if (!sample.length || !Number.isFinite(peak)) {
      return { minDb: this.floor ?? -100, maxDb: this.ceil ?? -10 }
    }
    sample.sort((a, b) => a - b)
    const p30 = sample[Math.floor(sample.length * 0.3)]

    const wantFloor = p30 - 3
    const wantCeil = Math.max(peak + 2, wantFloor + 12)

    this.floor = this.floor === null ? wantFloor : this.floor + (wantFloor - this.floor) * this.alpha
    this.ceil = this.ceil === null ? wantCeil : this.ceil + (wantCeil - this.ceil) * this.alpha

    return { minDb: this.floor, maxDb: this.ceil }
  }

  reset(): void {
    this.floor = null
    this.ceil = null
  }
}

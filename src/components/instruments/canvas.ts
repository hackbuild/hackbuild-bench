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
  utility: string
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
    utility: get('--hb-utility'),
  }
}

export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Calls back when the reduced motion setting changes, and returns a disposer.
 *
 * The setting can be turned on part way through a session, and an animation
 * already running has no other way to hear about it.
 */
export function onReducedMotion(cb: () => void): () => void {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)')
  query.addEventListener('change', cb)
  return () => query.removeEventListener('change', cb)
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

function byte(v: number): number {
  return Math.max(0, Math.min(255, v)) | 0
}

/**
 * Waterfall colormap: black to red to magenta to orange to yellow.
 *
 * The floor stays dark. A lifted floor buries the noise floor a carrier reads
 * against. Values come from the readouts, not the colour.
 */
export function heat(v: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, v))
  // both blue branches have to meet at t = 0.5. a step there draws a contour
  // across the picture wherever a signal crosses mid window.
  const b = t < 0.5 ? t * 2 * 160 : (1 - t) * 2 * 160
  return [byte(t * 3 * 255), byte((t - 0.35) * 2.2 * 255), byte(b)]
}

/**
 * Strongest bin in the slice of `bins` that falls on output column `x` of `w`.
 *
 * A stitched sweep hands over far more bins than the display has columns, so a
 * point sample drops carriers that are only a few bins wide.
 */
export function peakAt(bins: Float32Array, x: number, w: number): number {
  if (!bins.length) return -Infinity
  const lo = Math.min(bins.length - 1, Math.floor((x / w) * bins.length))
  const hi = Math.min(bins.length, Math.max(lo + 1, Math.floor(((x + 1) / w) * bins.length)))
  let v = -Infinity
  for (let i = lo; i < hi; i++) if (bins[i] > v) v = bins[i]
  return Number.isFinite(v) ? v : bins[lo]
}

/**
 * Strongest bin between two fractions of the whole span, for a zoomed view
 * whose edges fall between bins. Markers sit at exact fractions, so the trace
 * has to be mapped the same way to line up with them.
 */
export function peakBetween(bins: Float32Array, f0: number, f1: number): number {
  const n = bins.length
  if (!n) return -Infinity
  const lo = Math.min(n - 1, Math.max(0, Math.floor(f0 * n)))
  const hi = Math.min(n, Math.max(lo + 1, Math.ceil(f1 * n)))
  let v = -Infinity
  for (let i = lo; i < hi; i++) if (bins[i] > v) v = bins[i]
  return Number.isFinite(v) ? v : bins[lo]
}

/** Maps a dB magnitude onto 0 to 1 across the display window. */
export function normalise(db: number, minDb: number, maxDb: number): number {
  const span = maxDb - minDb
  if (!(span > 0) || !Number.isFinite(db)) return 0
  return Math.max(0, Math.min(1, (db - minDb) / span))
}

/** A press that travels less than this many CSS pixels counts as a tap. */
export const SLOP = 4

/** Marker movement per arrow key and per page key, as a fraction of the width. */
export const KEY_STEP = 0.01
export const PAGE_STEP = 0.1

/** Width of the keyboard handle that stands in for the marker, in CSS pixels. */
export const HANDLE_PX = 24

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

/** 1 or -1 for an arrow key that moves the marker, 0 for anything else. */
export function arrowStep(key: string): number {
  if (key === 'ArrowRight' || key === 'ArrowUp') return 1
  if (key === 'ArrowLeft' || key === 'ArrowDown') return -1
  return 0
}

/** Where a marker key puts the marker, null when the key moves no marker. */
export function markerKeyTarget(key: string, centre: number): number | null {
  const dir = arrowStep(key)
  if (dir) return clamp01(centre + dir * KEY_STEP)
  if (key === 'Home') return 0
  if (key === 'End') return 1
  if (key === 'PageUp') return clamp01(centre + PAGE_STEP)
  if (key === 'PageDown') return clamp01(centre - PAGE_STEP)
  return null
}

/** Spoken form of the marker, since the picture it sits on carries no text. */
export function markerReadout(marker: number | null, width: number): string {
  const at = ((marker ?? 0.5) * 100).toFixed(1)
  const wide = ((width ?? 0) * 100).toFixed(1)
  return `listening ${at}% across the window, ${wide}% wide`
}

/**
 * Left edge of the handle, centred on the marker.
 *
 * The shell clips its overflow, so a handle hanging past either end makes it a
 * scroll container and focusing the handle slides the picture sideways.
 */
export function handleLeft(marker: number): string {
  const half = HANDLE_PX / 2
  return `clamp(0px, calc(${marker * 100}% - ${half}px), calc(100% - ${HANDLE_PX}px))`
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

export { AutoRange } from '@/core/dsp/autoRange'

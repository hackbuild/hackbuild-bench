/**
 * Arithmetic behind a spectrum display: axis ticks, typed frequencies, peaks,
 * the noise floor, and channel power. Nothing here knows about a canvas or a
 * device, so every panel and every instrument reads the same numbers.
 */

export interface Tick {
  hz: number
  /** Where the tick sits across the visible span, 0 to 1. */
  at: number
  label: string
}

/** Steps a frequency axis may use, as multiples of a power of ten. */
const NICE = [1, 2, 5]

/**
 * Ticks for a frequency axis between low and high, spaced at least minPx
 * apart on an axis widthPx wide, on 1, 2 and 5 steps. Labels carry only the
 * decimals the step needs.
 */
export function frequencyTicks(lowHz: number, highHz: number, widthPx: number, minPx = 72): Tick[] {
  const span = highHz - lowHz
  if (!(span > 0) || !(widthPx > 0)) return []
  const most = Math.max(1, Math.floor(widthPx / minPx))
  const rough = span / most
  const mag = 10 ** Math.floor(Math.log10(rough))
  const step = (NICE.find((n) => n * mag >= rough) ?? 10) * mag
  const first = Math.ceil(lowHz / step) * step
  const unit = unitFor(Math.max(Math.abs(lowHz), Math.abs(highHz)))
  const places = Math.max(0, Math.ceil(-Math.log10(step / unit) - 1e-9))
  const out: Tick[] = []
  for (let hz = first; hz <= highHz + step * 1e-9; hz += step) {
    out.push({ hz, at: (hz - lowHz) / span, label: (hz / unit).toFixed(places) })
  }
  return out
}

/** Labels are read in the unit of the frequencies themselves, with the decimals the step needs. */
function unitFor(hz: number): number {
  return hz >= 1e6 ? 1e6 : hz >= 1e3 ? 1e3 : 1
}

/** The unit an axis labelled by frequencyTicks is read in. */
export function tickUnit(lowHz: number, highHz: number): string {
  const u = unitFor(Math.max(Math.abs(lowHz), Math.abs(highHz)))
  return u === 1e6 ? 'MHz' : u === 1e3 ? 'kHz' : 'Hz'
}

/** Ticks for a dB axis, every 10 dB unless the window is narrower than 30. */
export function dbTicks(minDb: number, maxDb: number): number[] {
  const span = maxDb - minDb
  if (!(span > 0)) return []
  const step = span > 60 ? 20 : span > 30 ? 10 : 5
  const out: number[] = []
  for (let db = Math.ceil(minDb / step) * step; db <= maxDb; db += step) out.push(db)
  return out
}

/**
 * Reads a typed frequency. A bare number under 10 000 is taken as MHz, since
 * that is how people say a frequency out loud. Suffixes k, m and g and the
 * units hz, khz, mhz and ghz are understood. Null for anything else.
 */
export function parseFrequency(text: string): number | null {
  const m = /^\s*([0-9]*\.?[0-9]+)\s*(g|m|k)?\s*(hz)?\s*$/i.exec(text.replace(/,/g, ''))
  if (!m) return null
  const v = Number(m[1])
  if (!Number.isFinite(v)) return null
  const suffix = (m[2] ?? '').toLowerCase()
  if (suffix === 'g') return v * 1e9
  if (suffix === 'm') return v * 1e6
  if (suffix === 'k') return v * 1e3
  if (m[3]) return v
  return v < 1e4 ? v * 1e6 : v
}

/** The nearest multiple of step. A step of 0 leaves the frequency alone. */
export function snapTo(hz: number, step: number): number {
  if (!(step > 0)) return hz
  return Math.round(hz / step) * step
}

/**
 * Median of the bins, which is where the noise floor sits as long as signals
 * occupy less than half the span.
 */
export function noiseFloor(bins: ArrayLike<number>, lo = 0, hi = bins.length): number {
  const vals: number[] = []
  for (let i = Math.max(0, lo); i < Math.min(bins.length, hi); i++) {
    if (Number.isFinite(bins[i])) vals.push(bins[i])
  }
  if (!vals.length) return -Infinity
  vals.sort((a, b) => a - b)
  return vals[vals.length >> 1]
}

/** Index of the strongest bin in [lo, hi). */
export function peakIndex(bins: ArrayLike<number>, lo = 0, hi = bins.length): number {
  let best = -1
  let v = -Infinity
  for (let i = Math.max(0, lo); i < Math.min(bins.length, hi); i++) {
    if (bins[i] > v) {
      v = bins[i]
      best = i
    }
  }
  return best
}

/**
 * The strongest local maximum below `below` dB that stands at least
 * `prominence` dB above the floor and sits `guard` bins away from every index
 * in `taken`. Repeated calls walk down the peaks, which is next peak search.
 */
export function nextPeak(
  bins: ArrayLike<number>,
  taken: number[],
  opts: { lo?: number; hi?: number; guard?: number; prominence?: number } = {},
): number {
  const lo = Math.max(1, opts.lo ?? 0)
  const hi = Math.min(bins.length - 1, opts.hi ?? bins.length)
  const guard = opts.guard ?? 8
  const floor = noiseFloor(bins, lo, hi)
  const prominence = opts.prominence ?? 6
  let best = -1
  let v = -Infinity
  for (let i = lo; i < hi; i++) {
    const b = bins[i]
    if (b <= v || b < floor + prominence) continue
    if (b < bins[i - 1] || b < bins[i + 1]) continue
    if (taken.some((t) => Math.abs(t - i) < guard)) continue
    v = b
    best = i
  }
  return best
}

/**
 * Equivalent noise bandwidth of the windows, in bins. A bin of a windowed
 * transform collects this many bins' worth of noise, which is what turns a
 * sum of bins into channel power and a bin width into a resolution bandwidth.
 */
export const ENBW: Record<string, number> = { rect: 1, hann: 1.5, hamming: 1.36, blackman: 1.73 }

/**
 * How far the median of noise read in dB sits below its mean power. Noise
 * power per bin is exponentially distributed, and its median is ln 2 of the
 * mean.
 */
export const MEDIAN_TO_MEAN_DB = -10 * Math.log10(Math.LN2)

/** The whole bins channelPower sums for a fractional range. */
export function binsIn(lo: number, hi: number, length: number): number {
  return Math.max(0, Math.min(length, Math.ceil(hi)) - Math.max(0, Math.floor(lo)))
}

/**
 * Total power between two bins, in dB on the same scale as the bins. The bins
 * are scaled for tone amplitude, so a carrier inside the channel reads at its
 * own level and the noise term is corrected by the window's noise bandwidth.
 */
export function channelPower(bins: ArrayLike<number>, lo: number, hi: number, enbw = ENBW.hann): number {
  let sum = 0
  let n = 0
  for (let i = Math.max(0, Math.floor(lo)); i < Math.min(bins.length, Math.ceil(hi)); i++) {
    if (!Number.isFinite(bins[i])) continue
    sum += 10 ** (bins[i] / 10)
    n++
  }
  if (!n) return -Infinity
  return 10 * Math.log10(sum / enbw)
}

/** Rows for a csv export: frequency in Hz and level in dB, one bin per row. */
export function spectrumCsv(bins: ArrayLike<number>, centerHz: number, spanHz: number): string {
  const n = bins.length
  const lines = ['hz,db']
  for (let i = 0; i < n; i++) {
    const hz = centerHz - spanHz / 2 + ((i + 0.5) * spanHz) / n
    lines.push(`${Math.round(hz)},${Number(bins[i]).toFixed(2)}`)
  }
  return lines.join('\n')
}

interface Reach {
  min: number
  max: number
  spans?: Array<[number, number]>
}

/** The reachable parts of a range, the whole of it when there are no holes. */
export function spansOf(r: Reach): Array<[number, number]> {
  return r.spans?.length ? r.spans : [[r.min, r.max]]
}

export function reaches(r: Reach, hz: number): boolean {
  return spansOf(r).some(([lo, hi]) => hz >= lo && hz <= hi)
}

/** The reachable frequency nearest hz. */
export function nearestReachable(r: Reach, hz: number): number {
  let best = hz
  let gap = Infinity
  for (const [lo, hi] of spansOf(r)) {
    const at = Math.min(hi, Math.max(lo, hz))
    if (Math.abs(at - hz) < gap) {
      gap = Math.abs(at - hz)
      best = at
    }
  }
  return best
}

/** The first hole between low and high, or null when one span covers both. */
export function holeBetween(r: Reach, lowHz: number, highHz: number): [number, number] | null {
  const spans = spansOf(r)
  if (spans.some(([lo, hi]) => lowHz >= lo && highHz <= hi)) return null
  for (let i = 0; i < spans.length - 1; i++) {
    const hole: [number, number] = [spans[i][1], spans[i + 1][0]]
    if (highHz > hole[0] && lowHz < hole[1]) return hole
  }
  return [Math.max(lowHz, r.min), Math.min(highHz, r.max)]
}

/**
 * The window a device that cannot retune holds, such as a recording: its
 * centre is fixed, so what it carries is the centre plus and minus half its
 * rate, less a guard for the filter roll off at the edges. Null for a device
 * that tunes.
 */
export function fixedWindow(r: Reach, sampleRate: number, guardHz = 0): [number, number] | null {
  if (r.spans?.length || r.min !== r.max || !(sampleRate > 0)) return null
  return [r.min - sampleRate / 2 + guardHz, r.min + sampleRate / 2 - guardHz]
}

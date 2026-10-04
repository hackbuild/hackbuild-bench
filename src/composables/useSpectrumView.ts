import { onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import { SpectrumAnalyzer, peakHoldInto } from '@/core/dsp/fft'
import type { WindowKind } from '@/core/dsp/fft'
import { AutoRange } from '@/core/dsp/autoRange'
import type { Artifact, FftFrame, IqChunk } from '@/core/types'

/** Past this rate a trace is redrawn faster than anyone can read it. */
const FRAME_MS = 1000 / 30

/** A device that stopped sending iq this long ago is read through its own frames. */
const IQ_STALE_MS = 400

/** The narrowest zoom, in bins, so a zoomed trace still has a shape. */
const MIN_VIEW_BINS = 24

export const FFT_SIZES = [512, 1024, 2048, 4096, 8192, 16384]
export const WINDOWS: WindowKind[] = ['hann', 'hamming', 'blackman', 'rect']
export const AVERAGES = [0, 2, 4, 8, 16, 32]

/**
 * What a spectrum display shows, shared by every panel that draws one.
 *
 * When the device streams iq the transform runs here, so the size, the window
 * and the dc block are the viewer's to choose. A device that only hands over
 * finished frames, such as a hardware sweep, is shown as it arrives. A sweep
 * stitched outside the driver feeds its panorama in through `feed`.
 */
export function useSpectrumView(deviceId: string) {
  const fftSize = ref(2048)
  const windowKind = ref<WindowKind>('hann')
  const dcBlock = ref(true)
  /** Frames averaged, 0 for none. */
  const average = ref(0)
  const holdMax = ref(false)
  const holdMin = ref(false)
  const frozen = ref(false)
  const autoRange = ref(true)
  /** Top of the manual window and its depth, in dB. */
  const refDb = ref(-10)
  const rangeDb = ref(80)
  /** The visible part of the span, as fractions of it. */
  const view = ref<[number, number]>([0, 1])

  const bins = shallowRef<Float32Array | null>(null)
  const maxBins = shallowRef<Float32Array | null>(null)
  const minBins = shallowRef<Float32Array | null>(null)
  const centerHz = ref(0)
  const spanHz = ref(0)
  const minDb = ref(-100)
  const maxDb = ref(-10)
  const frames = ref(0)
  /** True while the trace comes from this composable's own transform. */
  const local = ref(false)
  /** True while an outside panorama owns the display. */
  const external = ref(false)

  const range = new AutoRange()
  let analyzer = new SpectrumAnalyzer(fftSize.value, windowKind.value)
  let acc = new Float32Array(fftSize.value * 2)
  let fill = 0
  let accCenter = 0
  let accRate = 0
  let lastIqAt = 0
  let lastFrameAt = 0
  let avg: Float32Array | null = null

  function resetTraces(): void {
    avg = null
    maxBins.value = null
    minBins.value = null
    range.reset()
  }

  function publish(frame: Float32Array, center: number, span: number): void {
    frames.value++
    if (frozen.value) return
    if (center !== centerHz.value || span !== spanHz.value || (avg && avg.length !== frame.length)) {
      resetTraces()
    }
    centerHz.value = center
    spanHz.value = span

    let shown = frame
    if (average.value > 1) {
      const a = 1 / average.value
      if (!avg || avg.length !== frame.length) avg = frame.slice()
      else for (let i = 0; i < frame.length; i++) avg[i] += (frame[i] - avg[i]) * a
      shown = avg.slice()
    } else {
      avg = null
      shown = frame.slice()
    }
    bins.value = shown

    if (holdMax.value) {
      const m = maxBins.value && maxBins.value.length === shown.length ? maxBins.value : shown.slice()
      peakHoldInto(m, shown, 0)
      maxBins.value = m.slice()
    }
    if (holdMin.value) {
      const m = minBins.value && minBins.value.length === shown.length ? minBins.value : shown.slice()
      for (let i = 0; i < shown.length; i++) if (shown[i] < m[i]) m[i] = shown[i]
      minBins.value = m.slice()
    }

    if (autoRange.value) {
      // fitted to what is on screen, so zooming onto a weak signal brings it up.
      const n = shown.length
      const lo = Math.floor(view.value[0] * n)
      const hi = Math.max(lo + 2, Math.ceil(view.value[1] * n))
      const win = range.update(lo === 0 && hi >= n ? shown : shown.subarray(lo, hi))
      minDb.value = win.minDb
      maxDb.value = win.maxDb
    } else applyManual()
  }

  function applyManual(): void {
    maxDb.value = refDb.value
    minDb.value = refDb.value - rangeDb.value
  }

  // a frozen or idle trace publishes nothing, and the window still has to follow the knobs.
  watch([autoRange, refDb, rangeDb], () => {
    if (!autoRange.value) applyManual()
    else range.reset()
  })
  watch(view, () => range.reset())

  function onIq(c: IqChunk): void {
    lastIqAt = performance.now()
    local.value = true
    if (c.centerHz !== accCenter || c.sampleRate !== accRate) {
      fill = 0
      accCenter = c.centerHz
      accRate = c.sampleRate
    }
    const s = c.samples
    let i = 0
    while (i < s.length) {
      const take = Math.min(acc.length - fill, s.length - i)
      acc.set(s.subarray(i, i + take), fill)
      fill += take
      i += take
      if (fill < acc.length) break
      fill = 0
      const now = performance.now()
      if (now - lastFrameAt < FRAME_MS) continue
      lastFrameAt = now
      if (dcBlock.value) removeMean(acc)
      publish(analyzer.process(acc), c.centerHz, c.sampleRate)
    }
  }

  function onFft(f: FftFrame): void {
    if (performance.now() - lastIqAt < IQ_STALE_MS) return
    local.value = false
    publish(f.bins, f.centerHz, f.sampleRate)
  }

  const stop = bus.onDeviceArtifact(deviceId, (a: Artifact) => {
    if (external.value) return
    if (a.kind === 'iq') onIq(a as IqChunk)
    else if (a.kind === 'fft') onFft(a as FftFrame)
  })

  /** Shows a panorama built outside the driver, until `release` hands the display back. */
  function feed(frame: Float32Array, center: number, span: number): void {
    external.value = true
    publish(frame, center, span)
  }

  /**
   * Hands the display back to the device. The last panorama and its holds
   * stay up to be read or exported, until the next live frame replaces them.
   */
  function release(): void {
    external.value = false
  }

  watch([fftSize, windowKind], () => {
    analyzer = new SpectrumAnalyzer(fftSize.value, windowKind.value)
    acc = new Float32Array(fftSize.value * 2)
    fill = 0
    resetTraces()
    fit()
  })

  watch(holdMax, (on) => {
    if (!on) maxBins.value = null
  })
  watch(holdMin, (on) => {
    if (!on) minBins.value = null
  })

  function clearHolds(): void {
    maxBins.value = null
    minBins.value = null
  }

  function minWidth(): number {
    const n = bins.value?.length ?? fftSize.value
    return Math.min(1, MIN_VIEW_BINS / Math.max(1, n))
  }

  /** Zooms by factor about a point given as a fraction of the whole span. */
  function zoom(factor: number, about = (view.value[0] + view.value[1]) / 2): void {
    const [a, b] = view.value
    const width = Math.min(1, Math.max(minWidth(), (b - a) / factor))
    let lo = about - ((about - a) * width) / (b - a)
    lo = Math.min(1 - width, Math.max(0, lo))
    view.value = [lo, lo + width]
  }

  /** Moves the visible part by a fraction of the whole span. */
  function pan(delta: number): void {
    const [a, b] = view.value
    const width = b - a
    const lo = Math.min(1 - width, Math.max(0, a + delta))
    view.value = [lo, lo + width]
  }

  function fit(): void {
    view.value = [0, 1]
  }

  /** Centres the view on a fraction of the span without changing its width. */
  function centreOn(f: number): void {
    const width = view.value[1] - view.value[0]
    const lo = Math.min(1 - width, Math.max(0, f - width / 2))
    view.value = [lo, lo + width]
  }

  onBeforeUnmount(stop)

  return {
    fftSize,
    windowKind,
    dcBlock,
    average,
    holdMax,
    holdMin,
    frozen,
    autoRange,
    refDb,
    rangeDb,
    view,
    bins,
    maxBins,
    minBins,
    centerHz,
    spanHz,
    minDb,
    maxDb,
    frames,
    local,
    external,
    feed,
    release,
    clearHolds,
    zoom,
    pan,
    fit,
    centreOn,
  }
}

/** Subtracts the mean of i and of q, which takes out the spike at dc. */
function removeMean(iq: Float32Array): void {
  let si = 0
  let sq = 0
  const n = iq.length >> 1
  for (let k = 0; k < iq.length; k += 2) {
    si += iq[k]
    sq += iq[k + 1]
  }
  si /= n
  sq /= n
  for (let k = 0; k < iq.length; k += 2) {
    iq[k] -= si
    iq[k + 1] -= sq
  }
}

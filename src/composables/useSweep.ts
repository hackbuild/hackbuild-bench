import { onBeforeUnmount, ref } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import { SpectrumAnalyzer } from '@/core/dsp/fft'
import type { Artifact, IqChunk } from '@/core/types'

/** The share of each window kept, since the edges roll off in the resampler filter. */
const KEEP = 0.75

/** How far a chunk's centre may sit from the step's, for a pll that rounds. */
const CENTRE_SLACK_HZ = 5000

/** Chunks thrown away after a retune, while the pll settles and the fifo drains. */
const SETTLE_CHUNKS = 3

/** Transforms averaged per step, so one noise spike does not read as a carrier. */
const PER_STEP = 4

const FFT_SIZE = 1024

/** How often a sweep checks that its stream is still alive, since a dead one sends no chunk to wake it. */
const ALIVE_POLL_MS = 1000

/** The stitched picture is capped here, columns past it are folded by maximum. */
const MAX_BINS = 16384

export interface Panorama {
  bins: Float32Array
  centerHz: number
  spanHz: number
}

/**
 * Steps a radio across a range wider than it can see at once and stitches
 * the windows into one picture, for radios with no sweep of their own.
 *
 * Pacing comes from the iq chunks themselves, never a timer, since a
 * background tab throttles timers to one a second.
 */
export function useSweep(deviceId: string, onPass: (p: Panorama) => void) {
  const running = ref(false)
  /** Where the sweep has reached, 0 to 1. */
  const progress = ref(0)
  const passes = ref(0)
  const error = ref<string | null>(null)

  let stopFlag = false
  let unsub: (() => void) | null = null
  let waiter: ((c: IqChunk) => void) | null = null

  /** Resolves on the next chunk, or at once with an empty one after stop. */
  function nextChunk(): Promise<IqChunk> {
    if (stopFlag) return Promise.resolve(empty())
    return new Promise((resolve) => {
      waiter = resolve
    })
  }

  function empty(): IqChunk {
    return { kind: 'iq', samples: new Float32Array(0), centerHz: 0, sampleRate: 0, dropped: 0, source: deviceId, seq: 0, t: 0, wall: 0 }
  }

  async function run(lowHz: number, highHz: number): Promise<void> {
    if (running.value) return
    const node = bus.node(deviceId)
    if (!node) return
    if (!(highHz > lowHz)) return
    running.value = true
    stopFlag = false
    error.value = null
    passes.value = 0
    const home = node.params.centerHz
    const wasStreaming = node.status === 'streaming'

    const alive = setInterval(() => {
      const n = bus.node(deviceId)
      if (!n || n.status === 'error') {
        error.value = n?.error ?? 'the radio went away'
        stop()
      }
    }, ALIVE_POLL_MS)

    unsub = bus.onDeviceArtifact(deviceId, (a: Artifact) => {
      if (a.kind !== 'iq' || !waiter) return
      const w = waiter
      waiter = null
      w(a as IqChunk)
    })

    try {
      if (!wasStreaming) await bus.start(deviceId, 'iq')
      // the window is whatever the chunks carry, which a device may deliver
      // below the rate it was asked for.
      const rate = (await nextChunk()).sampleRate || node.params.sampleRate
      if (!rate) throw new Error('the radio reports no sample rate')
      const hop = rate * KEEP
      const span = highHz - lowHz
      const steps = Math.max(1, Math.ceil(span / hop))
      const binHz = rate / FFT_SIZE
      const len = Math.min(MAX_BINS, Math.max(16, Math.ceil(span / binHz)))
      const analyzer = new SpectrumAnalyzer(FFT_SIZE)
      const pano = new Float32Array(len).fill(-Infinity)

      // each pass overwrites the last one window by window, so the picture
      // updates in place instead of blanking at the start of every pass.
      while (!stopFlag) {
        for (let s = 0; s < steps && !stopFlag; s++) {
          // the last window is pulled back inside the range, since its centre
          // past the stop can sit beyond what the tuner reaches.
          const center =
            span <= hop ? lowHz + span / 2 : Math.min(highHz - hop / 2, lowHz + hop * (s + 0.5))
          await bus.configure(deviceId, { centerHz: center })
          for (let k = 0; k < SETTLE_CHUNKS; k++) await nextChunk()
          const power = new Float32Array(FFT_SIZE)
          let got = 0
          while (got < PER_STEP && !stopFlag) {
            const c = await nextChunk()
            if (!c.samples.length) continue
            if (c.sampleRate !== rate) throw new Error('the sample rate changed under the sweep')
            if (Math.abs(c.centerHz - center) > CENTRE_SLACK_HZ) continue
            const db = analyzer.process(c.samples)
            for (let i = 0; i < FFT_SIZE; i++) power[i] += 10 ** (db[i] / 10)
            got++
          }
          // a stop that landed mid step leaves nothing measured, and an empty
          // window would paint a notch into the picture.
          if (!got) break
          const first = Math.floor((FFT_SIZE * (1 - KEEP)) / 2)
          const touched = new Set<number>()
          for (let i = first; i < FFT_SIZE - first; i++) {
            const hz = center - rate / 2 + ((i + 0.5) * rate) / FFT_SIZE
            if (hz < lowHz || hz >= highHz) continue
            const j = Math.min(len - 1, Math.floor(((hz - lowHz) / span) * len))
            const v = 10 * Math.log10(power[i] / Math.max(1, got) + 1e-20)
            // a column takes the strongest bin that lands in it this pass.
            if (!touched.has(j) || v > pano[j]) pano[j] = v
            touched.add(j)
          }
          progress.value = (s + 1) / steps
          onPass({ bins: fillGaps(pano), centerHz: lowHz + span / 2, spanHz: span })
        }
        passes.value++
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      clearInterval(alive)
      unsub?.()
      unsub = null
      waiter = null
      try {
        await bus.configure(deviceId, { centerHz: home })
        if (!wasStreaming) await bus.stop(deviceId)
      } catch {
        // the device may have gone away mid sweep.
      }
      // only now, so a restart cannot find this run's stream and lose it to this stop.
      running.value = false
    }
  }

  function stop(): void {
    stopFlag = true
    // a chunk may never come if the stream died, so the waiter is released here.
    const w = waiter
    waiter = null
    w?.(empty())
  }

  onBeforeUnmount(stop)

  return { running, progress, passes, error, run, stop }
}

/** Columns no window reached yet copy their left neighbour, so the trace has no holes. */
function fillGaps(pano: Float32Array): Float32Array {
  const out = pano.slice()
  let last = -140
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i])) last = out[i]
    else out[i] = last
  }
  return out
}

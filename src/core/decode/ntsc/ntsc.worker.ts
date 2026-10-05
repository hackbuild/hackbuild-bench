import { NtscDecoder } from './index'
import type { NtscStatus, PictureLevels } from './index'

/**
 * Runs the analog tv chain off the main thread. At 2.4 Msps the carrier
 * mixer and the line cutting are most of a core's worth of small steps.
 */

export type NtscWorkerIn =
  | {
      type: 'start'
      gen: number
      rate: number
      carrierOffsetHz: number
      searchHz: number
    }
  | { type: 'iq'; gen: number; samples: Float32Array }
  | { type: 'levels'; levels: PictureLevels }

export type NtscWorkerOut =
  | { type: 'frame'; gen: number; pixels: Uint8ClampedArray }
  | { type: 'status'; gen: number; consumed: number; status: NtscStatus }

const STATUS_MS = 250

// the project compiles against the dom lib, so the worker scope is described here.
const scope = self as unknown as {
  postMessage(message: NtscWorkerOut, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<NtscWorkerIn>) => void) | null
}

let decoder: NtscDecoder | null = null
let gen = 0
let consumed = 0
let sentAt = 0
let levels: PictureLevels = { brightness: 0, contrast: 1 }

scope.onmessage = (e: MessageEvent<NtscWorkerIn>) => {
  const m = e.data
  if (m.type === 'levels') {
    levels = m.levels
    if (decoder) decoder.levels = levels
    return
  }
  if (m.type === 'start') {
    gen = m.gen
    decoder = new NtscDecoder(m.rate, m.carrierOffsetHz, m.searchHz)
    decoder.levels = levels
    const g = gen
    decoder.onFrame = (pixels) => scope.postMessage({ type: 'frame', gen: g, pixels }, [pixels.buffer])
    return
  }
  consumed += m.samples.length / 2
  // chunks queued before a retune belong to the window tuned away from.
  if (m.gen !== gen || !decoder) return
  decoder.feed(m.samples)
  const now = performance.now()
  if (now - sentAt >= STATUS_MS) {
    sentAt = now
    scope.postMessage({
      type: 'status',
      gen,
      consumed,
      status: decoder.status,
    })
  }
}

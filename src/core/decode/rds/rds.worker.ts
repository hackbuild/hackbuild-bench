import { RdsDecoder } from './index'
import type { RdsEvent, RdsSnapshot, RdsStatus } from './index'

/**
 * Runs the RDS chain off the main thread. At 2.4 Msps the front end alone is
 * a tenth of a core, which the spectrum and the audio cannot spare.
 */

export type RdsWorkerIn =
  | { type: 'iq'; gen: number; samples: Float32Array; sampleRate: number; offsetHz: number }
  | { type: 'reset'; gen: number }

/**
 * Every message names the generation it belongs to, so the page can drop what
 * was decoded for a station it has since tuned away from. A status also says
 * how many samples the worker has worked through, which is how the page sees
 * a backlog building.
 */
export type RdsWorkerOut =
  | { type: 'event'; gen: number; event: RdsEvent; snapshot: RdsSnapshot }
  | { type: 'status'; gen: number; consumed: number; status: RdsStatus; snapshot: RdsSnapshot }

const STATUS_MS = 250

// the project compiles against the dom lib, so the worker scope is described here.
const scope = self as unknown as {
  postMessage(message: RdsWorkerOut): void
  onmessage: ((e: MessageEvent<RdsWorkerIn>) => void) | null
}
const decoder = new RdsDecoder({ maxBurst: 5, rbds: true })
let sentAt = 0
let gen = 0
let consumed = 0

function post(msg: RdsWorkerOut): void {
  scope.postMessage(msg)
}

decoder.onEvent = (event) => post({ type: 'event', gen, event, snapshot: decoder.snapshot() })

function status(): void {
  post({ type: 'status', gen, consumed, status: decoder.status, snapshot: decoder.snapshot() })
}

scope.onmessage = (e: MessageEvent<RdsWorkerIn>) => {
  const m = e.data
  if (m.type === 'reset') {
    gen = m.gen
    decoder.reset()
    status()
    return
  }
  consumed += m.samples.length / 2
  // chunks queued before a reset belong to the station tuned away from.
  if (m.gen !== gen) return
  decoder.feedIq(m.samples, m.sampleRate, m.offsetHz)
  const now = performance.now()
  if (now - sentAt >= STATUS_MS) {
    sentAt = now
    status()
  }
}

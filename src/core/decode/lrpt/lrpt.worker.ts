/**
 * Runs the LRPT decoder off the main thread. The demod and Viterbi decoder
 * together take a few percent of a core at 1 Msps, which is still enough to
 * stutter a page that redraws a waterfall, so they live here.
 *
 * The demo transmitter lives here too, so demo mode exercises the same
 * thread and the same messages as a live pass.
 */

import { LrptDecoder } from './index'
import type { LrptLink, LrptStats } from './index'
import { LrptDemoSource } from './demo'

export type LrptRequest =
  | { type: 'config'; link: LrptLink; offsetHz: number }
  | { type: 'iq'; samples: Float32Array; rate: number; ack?: boolean }
  | { type: 'demo'; ms: number }
  | { type: 'finish'; ack?: boolean }
  | { type: 'reset' }

export interface StripMessage {
  apid: number
  pass: number
  scan: number
  x: number
  pixels: Uint8Array
}

export type LrptReply =
  | { type: 'stats'; stats: LrptStats; demo: { progress: number; done: boolean } | null }
  | { type: 'strips'; strips: StripMessage[] }
  | { type: 'ack' }

const STATS_MS = 200

let decoder = new LrptDecoder({ link: 'm2x' })
let demo: LrptDemoSource | null = null
let pending: StripMessage[] = []
let lastStats = 0

function wire(d: LrptDecoder): void {
  d.onStrip = (s) => pending.push({ apid: s.apid, pass: s.pass, scan: s.scan, x: s.x, pixels: s.pixels })
}
wire(decoder)

function flush(force: boolean): void {
  if (pending.length) {
    const strips = pending
    pending = []
    postMessage({ type: 'strips', strips } satisfies LrptReply, { transfer: strips.map((s) => s.pixels.buffer) })
  }
  const now = performance.now()
  if (!force && now - lastStats < STATS_MS) return
  lastStats = now
  const stats = decoder.stats
  stats.demod = { ...stats.demod, constellation: stats.demod.constellation.slice() }
  const d = demo ? { progress: demo.progress, done: demo.done } : null
  postMessage({ type: 'stats', stats, demo: d } satisfies LrptReply)
}

onmessage = (e: MessageEvent<LrptRequest>) => {
  const m = e.data
  switch (m.type) {
    case 'config':
      decoder = new LrptDecoder({ link: m.link, offsetHz: m.offsetHz })
      wire(decoder)
      demo = null
      pending = []
      flush(true)
      break
    case 'iq':
      decoder.feedIq(m.samples, m.rate)
      flush(false)
      if (m.ack) postMessage({ type: 'ack' } satisfies LrptReply)
      break
    case 'demo':
      if (!demo) demo = new LrptDemoSource()
      if (!demo.done) decoder.feedIq(demo.read(m.ms), demo.sampleRate)
      if (demo.done) decoder.finish()
      // every step answers, which is what paces the next one.
      flush(true)
      break
    case 'finish':
      decoder.finish()
      flush(true)
      if (m.ack) postMessage({ type: 'ack' } satisfies LrptReply)
      break
    case 'reset':
      decoder.reset()
      demo = null
      pending = []
      flush(true)
      break
  }
}

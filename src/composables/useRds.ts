import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { Ref } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import type { RdsEvent, RdsSnapshot, RdsStatus } from '@/core/decode/rds'
import type { RdsWorkerIn, RdsWorkerOut } from '@/core/decode/rds/rds.worker'
import { PTY_RBDS } from '@/core/decode/rds'
import type { Artifact, IqChunk } from '@/core/types'

/** A station that has gone quiet this long no longer counts as carrying RDS. */
const STALE_MS = 6000

/** Past this many seconds of iq waiting on the worker, chunks are skipped rather than queued. */
const BACKLOG_S = 2

const encoder = new TextEncoder()

function hex(pi: number): string {
  return pi.toString(16).toUpperCase().padStart(4, '0')
}

function describe(e: RdsEvent, s: RdsSnapshot): string | null {
  const who = s.callSign ?? (s.pi !== null ? hex(s.pi) : 'rds')
  switch (e.type) {
    case 'pi':
      return `${who} pi ${hex(e.pi)}`
    case 'ps':
      return `${who} name ${e.ps.trim()}`
    case 'rt':
      return `${who} text ${e.rt}`
    case 'pty':
      return `${who} type ${PTY_RBDS[e.pty] ?? e.pty}`
    case 'ct': {
      const local = new Date(e.clock.utcMs + e.clock.offsetMin * 60_000)
      const hh = String(local.getUTCHours()).padStart(2, '0')
      const mm = String(local.getUTCMinutes()).padStart(2, '0')
      return `${who} clock ${hh}:${mm} local`
    }
    case 'af':
      return `${who} also on ${e.afHz.map((h) => (h / 1e6).toFixed(1)).join(', ')} mhz`
    default:
      return null
  }
}

/**
 * RDS for whatever a device is streaming, decoded at the listening point
 * rather than the centre, in a worker.
 *
 * It only reads the iq already on the bus, so it never starts or stops the
 * radio. Each thing the station says is published as a packet with proto
 * 'rds', so the session log and the automations see it.
 */
export function useRds(deviceId: string, enabled: Ref<boolean>, offsetHz: Ref<number>) {
  const snapshot = shallowRef<RdsSnapshot | null>(null)
  const status = shallowRef<RdsStatus | null>(null)
  const lastHeard = ref(0)
  const now = ref(Date.now())

  let worker: Worker | null = null
  let centerHz = 0
  let sentOffset = Number.NaN
  let gen = 0
  let posted = 0
  let consumed = 0

  function ensureWorker(): Worker {
    if (worker) return worker
    worker = new Worker(new URL('../core/decode/rds/rds.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<RdsWorkerOut>) => {
      const m = e.data
      if (m.type === 'status') consumed = m.consumed
      if (m.gen !== gen) return
      snapshot.value = m.snapshot
      if (m.type === 'status') {
        status.value = m.status
        if (m.status.synced && m.snapshot.pi !== null) lastHeard.value = Date.now()
        return
      }
      lastHeard.value = Date.now()
      publish(m.event, m.snapshot)
    }
    worker.onerror = (e) => {
      console.warn('rds worker failed', e.message)
      worker?.terminate()
      worker = null
      posted = 0
      consumed = 0
    }
    // a fresh worker starts at generation zero, so it is told the current one.
    const hello: RdsWorkerIn = { type: 'reset', gen }
    worker.postMessage(hello)
    return worker
  }

  function publish(e: RdsEvent, s: RdsSnapshot): void {
    const summary = describe(e, s)
    if (!summary) return
    bus.emitDecoded(deviceId, {
      kind: 'packet',
      proto: 'rds',
      bytes: encoder.encode(summary),
      summary,
      fields: {
        event: e.type,
        frequencyHz: centerHz + offsetHz.value,
        pi: s.pi !== null ? hex(s.pi) : null,
        callSign: s.callSign,
        ps: s.ps,
        radiotext: s.rt,
        pty: s.ptyName,
        tp: s.tp,
        ta: s.ta,
        clockUtc: s.clock ? new Date(s.clock.utcMs).toISOString() : null,
        alternativesHz: s.afHz,
      },
    })
  }

  function reset(): void {
    snapshot.value = null
    status.value = null
    lastHeard.value = 0
    gen++
    const msg: RdsWorkerIn = { type: 'reset', gen }
    worker?.postMessage(msg)
  }

  const stop = bus.onDeviceArtifact(deviceId, (a: Artifact) => {
    if (a.kind !== 'iq' || !enabled.value) return
    const chunk = a as IqChunk
    // a retune or a new listening point is a different station.
    if (chunk.centerHz !== centerHz || offsetHz.value !== sentOffset) {
      if (centerHz !== 0 || !Number.isNaN(sentOffset)) reset()
      centerHz = chunk.centerHz
      sentOffset = offsetHz.value
    }
    const w = ensureWorker()
    const n = chunk.samples.length / 2
    if (posted - consumed > chunk.sampleRate * BACKLOG_S) return
    posted += n
    const copy = chunk.samples.slice()
    const msg: RdsWorkerIn = { type: 'iq', gen, samples: copy, sampleRate: chunk.sampleRate, offsetHz: sentOffset }
    w.postMessage(msg, [copy.buffer])
  })

  watch(enabled, (on) => {
    if (!on) reset()
  })

  const tick = window.setInterval(() => (now.value = Date.now()), 1000)

  /** True while the listening point carries RDS that has been heard lately. */
  const present = computed(() => {
    const s = snapshot.value
    return !!s && s.pi !== null && now.value - lastHeard.value < STALE_MS
  })

  onBeforeUnmount(() => {
    stop()
    window.clearInterval(tick)
    worker?.terminate()
    worker = null
  })

  return { snapshot, status, present, reset }
}

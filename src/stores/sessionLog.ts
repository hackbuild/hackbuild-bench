import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import type { Artifact, BusEvent } from '@/core/types'

/**
 * The session log. One place that answers "what has happened on this bench".
 *
 * It always records lifecycle events (a device connected, a stream started, an
 * error) because those are cheap and rare. It records captured artifacts,
 * packets, decoded lines, transcripts, and readings, only while recording is
 * on, because those arrive fast. High rate iq and fft frames are never logged,
 * they would bury everything else.
 */

export type LogKind = 'event' | 'packet' | 'line' | 'transcript' | 'reading' | 'note' | 'error'

export interface LogEntry {
  id: number
  at: number
  kind: LogKind
  /** Device label or the source of the entry. */
  source: string
  message: string
}

const CAP = 2000

/** How long a burst of entries may wait before it shows in the list. */
const FLUSH_MS = 100

export const useSessionLog = defineStore('sessionLog', () => {
  const entries = ref<LogEntry[]>([])
  const recording = ref(false)
  const startedAt = ref(0)
  let counter = 0

  /**
   * Entries waiting to join the list, oldest first. A decoder can publish
   * hundreds of packets a second, and rebuilding the capped list for each one
   * costs a copy of the whole list every time, so they join in batches.
   */
  let pending: LogEntry[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    flushTimer = null
    if (!pending.length) return
    const fresh = pending.reverse()
    pending = []
    entries.value = [...fresh, ...entries.value].slice(0, CAP)
  }

  function push(kind: LogKind, source: string, message: string): void {
    pending.push({ id: ++counter, at: Date.now(), kind, source, message })
    if (pending.length > CAP) pending.splice(0, pending.length - CAP)
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS)
  }

  function label(deviceId: string): string {
    return bus.node(deviceId)?.label ?? deviceId
  }

  // lifecycle events are always worth keeping.
  bus.onEvent((e: BusEvent) => {
    if (e.type === 'attached') push('event', label(e.deviceId), 'connected')
    else if (e.type === 'detached') push('event', label(e.deviceId), 'disconnected')
    else if (e.type === 'status') return
    else if (e.type === 'error' && e.message) push('error', label(e.deviceId), e.message)
    else if (e.type === 'log' && e.message) push('event', label(e.deviceId), e.message)
  })

  // artifacts only while recording, and never the high rate ones.
  bus.onArtifact((a: Artifact) => {
    if (!recording.value) return
    switch (a.kind) {
      case 'packet':
        push('packet', label(a.source), a.summary ?? `${a.proto} packet`)
        break
      case 'line':
        if (a.stream !== 'note') push('line', label(a.source), a.text)
        break
      case 'transcript':
        push('transcript', label(a.source), a.word)
        break
      case 'reading':
        push('reading', label(a.source), `${a.name} ${a.value}${a.unit ?? ''}`)
        break
      default:
        break
    }
  })

  function start(): void {
    recording.value = true
    startedAt.value = Date.now()
    push('note', 'recorder', 'recording started')
  }

  function stop(): void {
    if (recording.value) push('note', 'recorder', 'recording stopped')
    recording.value = false
  }

  function toggle(): void {
    if (recording.value) stop()
    else start()
  }

  /** Anything can drop a line in, the automations log action uses this. */
  function note(source: string, message: string): void {
    push('note', source, message)
  }

  function clear(): void {
    entries.value = []
  }

  const count = computed(() => entries.value.length)

  /** The whole log as text, for the export button. */
  function toText(): string {
    return [...entries.value]
      .reverse()
      .map((e) => {
        const t = new Date(e.at).toISOString()
        return `${t}\t${e.kind}\t${e.source}\t${e.message}`
      })
      .join('\n')
  }

  return { entries, recording, startedAt, count, start, stop, toggle, note, clear, toText }
})

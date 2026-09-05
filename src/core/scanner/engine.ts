import type { ConventionalChannel } from './conventional'

/**
 * The scan engine.
 *
 * Steps a receiver across a list of channels, stops on one that is busy, holds
 * while it stays busy, and resumes after a delay. This is the behaviour every
 * hardware scanner has, and it is the whole of conventional scanning.
 *
 * The engine does not touch hardware. It calls tune() and reads a level that
 * the caller supplies from whatever the radio is producing.
 */

export type ScanState = 'idle' | 'scanning' | 'receiving' | 'holding'

export interface ScanEntry {
  channel: ConventionalChannel
  /** Skipped by the user until they unlock it. */
  locked: boolean
  /** Sampled more often than the rest of the list while scanning. */
  priority: boolean
  /** Times this channel opened during the session. */
  hits: number
  lastHeardAt: number
}

export interface ScanCall {
  id: string
  channelId: string
  name: string
  service: string
  hz: number
  startedAt: number
  endedAt: number | null
  peakDb: number
  /** Filled in by transcription when it is running. */
  transcript?: string
}

export interface ScannerHooks {
  tune(hz: number, mode: string): void | Promise<void>
  /** Current signal level in dB. Read on every dwell. */
  level(): number
  onState?(state: ScanState, entry: ScanEntry | null): void
  onCall?(call: ScanCall): void
  onCallEnd?(call: ScanCall): void
}

export interface ScannerConfig {
  /** dB above which a channel counts as busy. */
  thresholdDb: number
  /** Milliseconds to sit on a channel listening for a carrier. */
  dwellMs: number
  /** Milliseconds to keep listening after a carrier drops, so replies are not cut off. */
  hangMs: number
  /** One priority channel is sampled for every this many regular channels. */
  priorityEvery: number
}

const DEFAULTS: ScannerConfig = {
  thresholdDb: -70,
  dwellMs: 90,
  hangMs: 1600,
  priorityEvery: 4,
}

export class Scanner {
  private hooks: ScannerHooks
  private config: ScannerConfig
  private entries: ScanEntry[] = []
  private index = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private state: ScanState = 'idle'
  private active: ScanCall | null = null
  private activeEntry: ScanEntry | null = null
  private lastCarrierAt = 0
  private held = false
  private calls: ScanCall[] = []
  private counter = 0
  private sincePriority = 0
  private priorityCursor = 0
  /**
   * Where the ordinary round robin has reached. A priority visit moves `index`
   * without touching this, otherwise the sweep resumes from the priority
   * channel and never leaves the few slots after it.
   */
  private sweep = 0

  constructor(hooks: ScannerHooks, config: Partial<ScannerConfig> = {}) {
    this.hooks = hooks
    this.config = { ...DEFAULTS, ...config }
  }

  configure(patch: Partial<ScannerConfig>): void {
    this.config = { ...this.config, ...patch }
  }

  setChannels(channels: ConventionalChannel[]): void {
    const previous = new Map(this.entries.map((e) => [e.channel.id, e]))
    this.entries = channels.map(
      (c) =>
        previous.get(c.id) ?? {
          channel: c,
          locked: false,
          priority: false,
          hits: 0,
          lastHeardAt: 0,
        },
    )
    if (this.index >= this.entries.length) this.index = 0
    if (this.sweep >= this.entries.length) this.sweep = 0
  }

  get list(): ScanEntry[] {
    return this.entries
  }

  get callLog(): ScanCall[] {
    return this.calls
  }

  get currentState(): ScanState {
    return this.state
  }

  get current(): ScanEntry | null {
    return this.entries[this.index] ?? null
  }

  get running(): boolean {
    return this.timer !== null
  }

  lock(id: string, locked: boolean): void {
    const e = this.entries.find((x) => x.channel.id === id)
    if (e) e.locked = locked
  }

  setPriority(id: string, priority: boolean): void {
    const e = this.entries.find((x) => x.channel.id === id)
    if (e) e.priority = priority
  }

  /** Freeze on the channel currently open, or release the freeze. */
  hold(on: boolean): void {
    this.held = on
  }

  get isHeld(): boolean {
    return this.held
  }

  /** Skip the channel we are sitting on and carry on scanning. */
  skip(): void {
    this.held = false
    this.closeCall()
    this.step()
  }

  start(): void {
    if (this.timer || !this.entries.length) return
    this.setState('scanning')
    this.visit()
    this.timer = setInterval(() => this.pump(), this.config.dwellMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.closeCall()
    this.setState('idle')
  }

  private setState(next: ScanState): void {
    if (this.state === next) return
    this.state = next
    this.hooks.onState?.(next, this.activeEntry)
  }

  private unlocked(): ScanEntry[] {
    return this.entries.filter((e) => !e.locked)
  }

  private step(): void {
    const list = this.entries
    if (!list.length) return
    const priorities = list.filter((e) => !e.locked && e.priority)
    if (priorities.length && ++this.sincePriority >= this.config.priorityEvery) {
      this.sincePriority = 0
      this.priorityCursor = (this.priorityCursor + 1) % priorities.length
      this.index = list.indexOf(priorities[this.priorityCursor])
      this.visit()
      return
    }
    let guard = 0
    do {
      this.sweep = (this.sweep + 1) % list.length
      guard++
    } while (list[this.sweep].locked && guard <= list.length)
    this.index = this.sweep
    this.visit()
  }

  private visit(): void {
    const entry = this.entries[this.index]
    if (!entry) return
    void this.hooks.tune(entry.channel.hz, entry.channel.mode)
  }

  private pump(): void {
    if (!this.entries.length) return
    if (!this.unlocked().length) {
      this.setState('idle')
      return
    }

    const db = this.hooks.level()
    const busy = db >= this.config.thresholdDb
    const now = Date.now()

    if (busy) {
      this.lastCarrierAt = now
      const entry = this.entries[this.index]

      if (!this.active) {
        entry.hits++
        entry.lastHeardAt = now
        this.activeEntry = entry
        this.active = {
          id: `call-${++this.counter}`,
          channelId: entry.channel.id,
          name: entry.channel.name,
          service: entry.channel.service,
          hz: entry.channel.hz,
          startedAt: now,
          endedAt: null,
          peakDb: db,
        }
        this.calls = [this.active, ...this.calls].slice(0, 300)
        this.hooks.onCall?.(this.active)
        this.setState('receiving')
      } else if (db > this.active.peakDb) {
        this.active.peakDb = db
      }
      return
    }

    if (this.active) {
      // hang time keeps the channel open through the gap between overs, so a
      // reply is not treated as a new call.
      if (now - this.lastCarrierAt < this.config.hangMs) return
      this.closeCall()
    }

    if (this.held) {
      this.setState('holding')
      return
    }

    this.setState('scanning')
    this.step()
  }

  private closeCall(): void {
    if (!this.active) return
    this.active.endedAt = Date.now()
    this.hooks.onCallEnd?.(this.active)
    this.active = null
    this.activeEntry = null
  }

  /** Attaches a transcript to the most recent call on a channel. */
  attachTranscript(channelId: string, text: string): void {
    const call = this.calls.find((c) => c.channelId === channelId)
    if (!call) return
    call.transcript = call.transcript ? `${call.transcript} ${text}` : text
  }
}

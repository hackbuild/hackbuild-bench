/**
 * Audio output for anything that produces mono float samples.
 *
 * The worklet lives in this file as a string and is loaded from a blob url.
 * A separate .js asset would have to survive the GitHub Pages base path, and
 * the worklet is the one module the bundler cannot rewrite for us.
 */

import { Resampler } from '@/core/dsp/demod'

export interface AudioSinkOptions {
  /** Seconds of audio the ring holds before it starts dropping. */
  capacitySeconds?: number
  volume?: number
}

export type AudioTap = (samples: Float32Array, sampleRate: number) => void

const WORKLET_SOURCE = `
class BenchSinkProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = options.processorOptions || {}
    this.cap = opts.capacity || 48000 * 4
    this.buf = new Float32Array(this.cap)
    this.read = 0
    this.write = 0
    this.avail = 0
    this.dropped = 0
    this.port.onmessage = (event) => {
      const data = event.data
      if (data === 'flush') {
        this.read = 0
        this.write = 0
        this.avail = 0
        return
      }
      const s = data
      const n = s.length
      if (n === 0) return
      const start = n > this.cap ? n - this.cap : 0
      const take = n - start
      const over = this.avail + take - this.cap
      if (over > 0) {
        this.read = (this.read + over) % this.cap
        this.avail -= over
        this.dropped += over
        this.port.postMessage({ dropped: this.dropped })
      }
      for (let i = 0; i < take; i++) {
        this.buf[this.write] = s[start + i]
        this.write = (this.write + 1) % this.cap
      }
      this.avail += take
    }
  }

  process(inputs, outputs) {
    const out = outputs[0]
    if (!out || out.length === 0) return true
    const ch = out[0]
    const n = ch.length
    if (this.avail >= n) {
      for (let i = 0; i < n; i++) {
        ch[i] = this.buf[this.read]
        this.read = (this.read + 1) % this.cap
      }
      this.avail -= n
    } else {
      ch.fill(0)
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch)
    return true
  }
}
registerProcessor('bench-sink', BenchSinkProcessor)
`

/** Fixed size ring used before the worklet exists and by the fallback path. */
class Ring {
  private buf: Float32Array
  private read = 0
  private write = 0
  private avail = 0
  dropped = 0

  constructor(capacity: number) {
    this.buf = new Float32Array(capacity)
  }

  get length(): number {
    return this.avail
  }

  push(samples: Float32Array): void {
    const cap = this.buf.length
    const start = samples.length > cap ? samples.length - cap : 0
    const take = samples.length - start
    const over = this.avail + take - cap
    if (over > 0) {
      this.read = (this.read + over) % cap
      this.avail -= over
      this.dropped += over
    }
    for (let i = 0; i < take; i++) {
      this.buf[this.write] = samples[start + i]
      this.write = (this.write + 1) % cap
    }
    this.avail += take
  }

  pull(out: Float32Array): boolean {
    const cap = this.buf.length
    if (this.avail < out.length) {
      out.fill(0)
      return false
    }
    for (let i = 0; i < out.length; i++) {
      out[i] = this.buf[this.read]
      this.read = (this.read + 1) % cap
    }
    this.avail -= out.length
    return true
  }

  drain(): Float32Array {
    const out = new Float32Array(this.avail)
    this.pull(out)
    return out
  }

  clear(): void {
    this.read = 0
    this.write = 0
    this.avail = 0
  }
}

export class AudioSink {
  private ctx: AudioContext | null = null
  private worklet: AudioWorkletNode | null = null
  private fallback: ScriptProcessorNode | null = null
  private gain: GainNode | null = null
  private ring: Ring
  private resampler = new Resampler()
  private resampleFrom = 0
  private taps = new Set<AudioTap>()
  private starting: Promise<void> | null = null
  private capacitySeconds: number
  private volume: number
  private droppedCount = 0

  /** Silences output without tearing down the graph or the ring. */
  muted = false

  constructor(opts: AudioSinkOptions = {}) {
    this.capacitySeconds = Math.max(0.25, opts.capacitySeconds ?? 4)
    this.volume = Math.min(1, Math.max(0, opts.volume ?? 0.7))
    this.ring = new Ring(Math.round(48000 * this.capacitySeconds))
  }

  get context(): AudioContext | null {
    return this.ctx
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000
  }

  get running(): boolean {
    return this.ctx?.state === 'running'
  }

  /** Samples thrown away because the consumer fell behind. */
  get dropped(): number {
    return this.droppedCount + this.ring.dropped
  }

  /** Which output path is live, for the panel to name honestly. */
  get backend(): 'worklet' | 'script-processor' | 'idle' {
    if (this.worklet) return 'worklet'
    if (this.fallback) return 'script-processor'
    return 'idle'
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v))
    if (this.gain) this.gain.gain.value = this.muted ? 0 : this.volume
  }

  getVolume(): number {
    return this.volume
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (this.gain) this.gain.gain.value = muted ? 0 : this.volume
  }

  /**
   * Listen to the same samples the speakers get. The transcriber uses this so
   * audio is demodulated once, not once per consumer.
   */
  tap(fn: AudioTap): () => void {
    this.taps.add(fn)
    return () => {
      this.taps.delete(fn)
    }
  }

  /** Must be called from a user gesture. Browsers start contexts suspended. */
  async resume(): Promise<void> {
    await this.ensure()
    if (this.ctx && this.ctx.state !== 'running') await this.ctx.resume()
  }

  /**
   * Queue mono audio. Resamples to the context rate when the rates differ.
   * Samples pushed before resume() land in the ring and play once it opens.
   */
  push(samples: Float32Array, sampleRate: number): void {
    if (samples.length === 0) return
    for (const fn of this.taps) fn(samples, sampleRate)

    const target = this.sampleRate
    let out = samples
    if (sampleRate > 0 && Math.abs(sampleRate - target) > 1) {
      if (this.resampleFrom !== sampleRate) {
        this.resampler = new Resampler()
        this.resampleFrom = sampleRate
      }
      out = this.resampler.process(samples, sampleRate / target)
    } else {
      this.resampleFrom = 0
    }
    if (out.length === 0) return

    if (this.worklet) {
      const copy = new Float32Array(out)
      this.worklet.port.postMessage(copy, [copy.buffer as ArrayBuffer])
    } else {
      this.ring.push(out)
    }
  }

  /** Drop everything queued. Used on a mode change so stale audio does not play. */
  flush(): void {
    this.ring.clear()
    this.worklet?.port.postMessage('flush')
  }

  async close(): Promise<void> {
    this.worklet?.port.postMessage('flush')
    this.worklet?.disconnect()
    this.fallback?.disconnect()
    this.gain?.disconnect()
    this.worklet = null
    this.fallback = null
    this.gain = null
    this.ring.clear()
    const ctx = this.ctx
    this.ctx = null
    this.starting = null
    if (ctx) await ctx.close()
  }

  // -------------------------------------------------------------------------

  private ensure(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = this.build().catch((err) => {
      this.starting = null
      throw err instanceof Error ? err : new Error(String(err))
    })
    return this.starting
  }

  private async build(): Promise<void> {
    if (this.ctx) return
    if (typeof AudioContext === 'undefined') {
      throw new Error('this browser has no web audio')
    }
    const ctx = new AudioContext()
    this.ctx = ctx

    const gain = ctx.createGain()
    gain.gain.value = this.muted ? 0 : this.volume
    gain.connect(ctx.destination)
    this.gain = gain

    const capacity = Math.round(ctx.sampleRate * this.capacitySeconds)
    const pending = this.ring.drain()
    this.ring = new Ring(capacity)

    if (typeof AudioWorkletNode !== 'undefined' && ctx.audioWorklet) {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
        try {
          await ctx.audioWorklet.addModule(url)
        } finally {
          URL.revokeObjectURL(url)
        }
        const node = new AudioWorkletNode(ctx, 'bench-sink', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: { capacity },
        })
        node.port.onmessage = (event: MessageEvent) => {
          const data = event.data as { dropped?: number }
          if (typeof data?.dropped === 'number') this.droppedCount = data.dropped
        }
        node.connect(gain)
        this.worklet = node
        if (pending.length) this.push(pending, ctx.sampleRate)
        return
      } catch {
        // some browsers refuse a blob module under a strict policy. the script
        // processor path below still produces sound.
      }
    }

    const node = ctx.createScriptProcessor(4096, 1, 1)
    node.onaudioprocess = (event) => {
      const out = event.outputBuffer.getChannelData(0)
      this.ring.pull(out)
    }
    node.connect(gain)
    this.fallback = node
    if (pending.length) this.ring.push(pending)
  }
}

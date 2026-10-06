/**
 * Whisper in the browser through transformers.js.
 *
 * The library is fetched from a CDN by a runtime import, never bundled, so the
 * app builds and runs with no network and the model only downloads when the
 * user asks for transcription. The import goes through a Function constructor
 * because a plain dynamic import with a variable url still gets rewritten by
 * the bundler.
 */

import { Resampler } from '@/core/dsp/demod'

export interface TranscriptLine {
  text: string
  /** Wall clock ms at the end of the window the text came from. */
  at: number
}

export interface TranscriberOptions {
  model?: string
  /** Seconds of audio handed to the model per pass. */
  windowSec?: number
  /** Seconds between passes. Windows overlap by windowSec minus strideSec. */
  strideSec?: number
  /** CDN builds tried in order. */
  urls?: string[]
}

export type ProgressReport = { status: string; progress: number; file?: string }

const RATE = 16000

const DEFAULT_URLS = [
  'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js',
  'https://esm.run/@huggingface/transformers@3.8.1',
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js',
]

const NOISE = /^\(?\s*(blank|silence|music|inaudible|noise|beep)\s*\)?\.?$/i

type AsrFn = (pcm: Float32Array, opts: Record<string, unknown>) => Promise<{ text?: string }>
type RemoteModule = Record<string, unknown>

const importRemote = new Function('u', 'return import(u)') as (u: string) => Promise<RemoteModule>

export class Transcriber {
  readonly modelId: string
  private windowSamples: number
  private strideSamples: number
  private urls: string[]

  private asr: AsrFn | null = null
  private loadPromise: Promise<void> | null = null
  private listeners = new Set<(line: TranscriptLine) => void>()

  private buf: Float32Array
  private len = 0
  private sinceLastPass = 0
  private resampler = new Resampler()
  private inputRate = 0
  private busy = false
  private stopped = false
  private prevWords: string[] = []

  /** Set when the model or the library could not be reached. Never thrown. */
  lastError: string | null = null
  backend: 'webgpu' | 'wasm' = 'wasm'
  loaded = false
  loading = false
  /** Windows skipped because inference was still running. */
  dropped = 0

  constructor(opts: TranscriberOptions = {}) {
    this.modelId = opts.model ?? 'Xenova/whisper-tiny.en'
    this.windowSamples = Math.round(RATE * Math.max(1, opts.windowSec ?? 5))
    this.strideSamples = Math.round(RATE * Math.max(0.5, opts.strideSec ?? 3))
    this.urls = opts.urls ?? DEFAULT_URLS
    this.buf = new Float32Array(this.windowSamples * 2)
  }

  /** Whether this runtime can host the model at all. */
  available(): boolean {
    return typeof WebAssembly !== 'undefined' && typeof fetch === 'function'
  }

  status(): string {
    if (this.lastError) return this.lastError
    if (this.loading) return 'loading the model'
    if (!this.loaded) return 'idle'
    const seconds = (this.len / RATE).toFixed(1)
    return `listening on ${this.backend}, ${seconds} s held`
  }

  /**
   * Fetch the library and build the pipeline. Resolves either way: check
   * lastError and loaded rather than catching.
   */
  load(onProgress?: (p: ProgressReport) => void): Promise<void> {
    if (this.loadPromise) return this.loadPromise
    this.loadPromise = this.build(onProgress)
    return this.loadPromise
  }

  private async build(onProgress?: (p: ProgressReport) => void): Promise<void> {
    this.loading = true
    this.lastError = null

    if (!this.available()) {
      this.loading = false
      this.lastError = 'this browser cannot run the speech model, it has no webassembly'
      return
    }

    let lib: RemoteModule | null = null
    for (const url of this.urls) {
      try {
        lib = await importRemote(url)
        if (lib && typeof lib.pipeline === 'function') break
        lib = null
      } catch {
        lib = null
      }
    }

    if (!lib) {
      this.loading = false
      this.lastError =
        'transcription needs one network fetch the first time to download the model and the library. no cached copy was found and the download did not go through.'
      return
    }

    try {
      const env = lib.env as Record<string, unknown> | undefined
      if (env) {
        const backends = env.backends as { onnx?: { wasm?: { proxy?: boolean } } } | undefined
        if (backends?.onnx?.wasm) backends.onnx.wasm.proxy = false
        env.allowLocalModels = false
      }
      const hasGpu = typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu
      this.backend = hasGpu ? 'webgpu' : 'wasm'

      const pipeline = lib.pipeline as (
        task: string,
        model: string,
        opts: Record<string, unknown>,
      ) => Promise<AsrFn>

      this.asr = await pipeline('automatic-speech-recognition', this.modelId, {
        device: hasGpu ? 'webgpu' : 'wasm',
        dtype: hasGpu ? 'fp32' : 'q8',
        progress_callback: (p: unknown) => {
          const report = p as { status?: string; progress?: number; file?: string }
          onProgress?.({
            status: report?.status ?? 'loading',
            progress: typeof report?.progress === 'number' ? report.progress : 0,
            file: report?.file,
          })
        },
      })
      this.loaded = true
    } catch (err) {
      this.lastError = `the speech model would not start: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      this.loading = false
    }
  }

  /**
   * Hand over audio at whatever rate produced it. Resampling to 16 kHz and
   * window scheduling happen here, so callers push and forget.
   */
  feed(samples: Float32Array, sampleRate: number): void {
    if (this.stopped || samples.length === 0) return

    let pcm = samples
    if (sampleRate > 0 && Math.abs(sampleRate - RATE) > 1) {
      if (this.inputRate !== sampleRate) {
        this.resampler = new Resampler()
        this.inputRate = sampleRate
      }
      pcm = this.resampler.process(samples, sampleRate / RATE)
    }
    if (pcm.length === 0) return

    if (pcm.length >= this.buf.length) {
      this.buf.set(pcm.subarray(pcm.length - this.buf.length))
      this.len = this.buf.length
    } else {
      const overflow = this.len + pcm.length - this.buf.length
      if (overflow > 0) {
        this.buf.copyWithin(0, overflow, this.len)
        this.len -= overflow
      }
      this.buf.set(pcm, this.len)
      this.len += pcm.length
    }

    this.sinceLastPass += pcm.length
    if (this.sinceLastPass >= this.strideSamples && this.len >= this.windowSamples) {
      this.sinceLastPass = 0
      void this.pass()
    }
  }

  private clips: Promise<unknown> = Promise.resolve()

  /**
   * Transcribes one whole clip, such as a radio call from key up to let go.
   * A whole utterance reads better than overlapping windows, and the text
   * belongs to the clip. Clips run one at a time, after any streaming pass.
   */
  transcribeClip(samples: Float32Array, sampleRate: number): Promise<string> {
    const run = async (): Promise<string> => {
      if (!this.asr || samples.length === 0) return ''
      const pcm = sampleRate > 0 && Math.abs(sampleRate - RATE) > 1 ? new Resampler().process(samples, sampleRate / RATE) : samples
      while (this.busy) await new Promise((r) => setTimeout(r, 50))
      this.busy = true
      try {
        const out = await this.asr(pcm, { chunk_length_s: 30, return_timestamps: false })
        const text = (out?.text ?? '').trim()
        return NOISE.test(text) ? '' : text
      } catch (err) {
        this.lastError = `transcription failed: ${err instanceof Error ? err.message : String(err)}`
        return ''
      } finally {
        this.busy = false
      }
    }
    const next = this.clips.then(run, run)
    this.clips = next.catch(() => undefined)
    return next
  }

  on(event: 'text', fn: (line: TranscriptLine) => void): () => void {
    if (event !== 'text') return () => undefined
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Stop accepting audio and drop what is held. The pipeline stays loaded. */
  stop(): void {
    this.stopped = true
    this.len = 0
    this.sinceLastPass = 0
    this.prevWords = []
  }

  /** Accept audio again after stop(). */
  start(): void {
    this.stopped = false
  }

  private async pass(): Promise<void> {
    if (!this.asr || this.busy || this.stopped) {
      if (this.busy) this.dropped++
      return
    }
    this.busy = true
    const window = this.buf.slice(this.len - this.windowSamples, this.len)
    try {
      const out = await this.asr(window, { chunk_length_s: 30, return_timestamps: false })
      const text = (out?.text ?? '').trim()
      if (text && !NOISE.test(text)) {
        const trimmed = this.trimOverlap(text)
        if (trimmed) {
          const line: TranscriptLine = { text: trimmed, at: Date.now() }
          for (const fn of this.listeners) fn(line)
        }
      }
    } catch (err) {
      this.lastError = `transcription pass failed: ${err instanceof Error ? err.message : String(err)}`
    } finally {
      this.busy = false
    }
  }

  /**
   * Consecutive windows share audio, so the model returns the tail of one pass
   * as the head of the next. Drop the leading run of the new text that repeats
   * the end of the last, matched on normalised tokens so different punctuation
   * and casing between passes still line up. The trim is driven only by matched
   * text, so a dropped pass with no shared audio removes nothing.
   */
  private trimOverlap(text: string): string {
    const raw = text.split(/\s+/).filter(Boolean)
    const norm = raw.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, ''))
    const prev = this.prevWords
    let overlap = 0
    const max = Math.min(prev.length, norm.length)
    for (let k = max; k >= 1; k--) {
      let same = 0
      for (let i = 0; i < k; i++) {
        if (norm[i] !== '' && prev[prev.length - k + i] === norm[i]) same++
      }
      if (same >= Math.ceil(k * 0.7)) {
        overlap = k
        break
      }
    }
    this.prevWords = norm
    return raw.slice(overlap).join(' ')
  }
}

/**
 * An IQ recording played as if it were a radio.
 *
 * It emits the same iq and fft artifacts a live receiver does, at the
 * recording's own pace, so every tool that decodes a radio decodes a file the
 * same way. A recording sits at one centre and one rate, so a tool that asks
 * for another is told so instead of being silently ignored.
 */

import { CAPABILITIES } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import type { DeviceDescriptor, FftFrame, IqChunk, TransportKind, UnitDescription } from '@/core/types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '@/core/drivers/types'
import { pickFile } from '@/core/transport/file'
import { SpectrumAnalyzer } from '@/core/dsp/fft'
import { parseFrequency } from '@/core/dsp/spectrumMath'
import { IQ_EXTENSIONS, SAMPLE_BYTES, layoutOf, toFloats } from './format'
import type { IqLayout } from './format'

/** Complex samples per chunk at radio rates, close to what the rtl-sdr hands over. */
const CHUNK = 8192

/** A narrow recording gets chunks of about this many seconds, so it still plays every tick. */
const CHUNK_S = 0.02

/** How often playback catches up with the clock. */
const TICK_MS = 20

/** A throttled tab wakes late, and catching up more than this at once floods every listener. */
const MAX_CATCH_UP_S = 0.5

const FFT_SIZE = 2048
const FFT_MIN_INTERVAL_MS = 1000 / 30

/** Enough of the head to find a wav's data chunk past any metadata. */
const HEAD_BYTES = 64 * 1024

interface Recording {
  file: File
  layout: IqLayout & { sampleRate: number; centerHz: number }
}

const descriptor: DeviceDescriptor = {
  kind: 'iqfile',
  name: 'IQ recording',
  blurb: 'play a recording as if it were a radio',
  icon: 'file-waveform',
  transports: ['file'],
  capabilities: [CAPABILITIES.OBSERVE_SPECTRUM, CAPABILITIES.CAPTURE_IQ, CAPABILITIES.AUDIO_DEMOD],
  params: [
    { key: 'centerHz', label: 'center', unit: 'Hz', min: 0, max: 6e9, default: 100e6, log: true },
    { key: 'sampleRate', label: 'sample rate', unit: 'sps', min: 1, max: 1e8, default: 2.4e6 },
    {
      key: 'loop',
      label: 'at the end',
      min: 0,
      max: 1,
      choices: [1, 0],
      choiceLabels: ['loop', 'stop'],
      default: 1,
    },
  ],
  accessFields: [
    {
      key: 'center',
      label: 'center frequency',
      type: 'text',
      placeholder: 'from the file',
    },
    { key: 'rate', label: 'sample rate', type: 'text', placeholder: 'from the file' },
  ],
  intro: {
    title: 'play a recording',
    body: [
      'pick a .cu8, .cs8, .cs16, .cf32 or iq .wav file. the centre and the rate come from a wav header or from the name, the way rtl_sdr, rtl_433, sdr#, sdr++ and gqrx write them. if the file says neither, type them below, like 1090m and 2.4m.',
      'every tool that works on a radio works on the recording, at the speed it was recorded.',
    ],
  },
  limits: {
    [CAPABILITIES.OBSERVE_SPECTRUM]: 'a recording sits at one centre and one rate. retuning it is refused.',
  },
}

function fmtMhz(hz: number): string {
  return `${Number((hz / 1e6).toFixed(4))} mhz`
}

class IqFileSession implements DeviceSession {
  private rec: Recording
  private ctx: DriverContext
  private analyzer = new SpectrumAnalyzer(FFT_SIZE)
  private lastFft = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private reading = false
  private offset = 0
  /** Complex samples owed to the clock since playback started. */
  private startedAt = 0
  private played = 0
  private loop = 1
  /** Complex samples per emitted chunk for this recording's rate. */
  private chunk: number
  /** Samples skipped while the tab slept, owed to the next chunk's dropped count. */
  private skipped = 0

  constructor(rec: Recording, ctx: DriverContext) {
    this.rec = rec
    this.ctx = ctx
    this.offset = rec.layout.dataOffset
    this.chunk = Math.max(64, Math.min(CHUNK, Math.floor(rec.layout.sampleRate * CHUNK_S)))
  }

  getCapabilities(): Capability[] {
    return descriptor.capabilities
  }

  getInfo(): Record<string, string> {
    const { file, layout } = this.rec
    const seconds = layout.dataBytes / SAMPLE_BYTES[layout.format] / layout.sampleRate
    return {
      file: file.name,
      format: layout.format,
      center: fmtMhz(layout.centerHz),
      sampleRate: `${Math.round(layout.sampleRate)} sps`,
      length: `${seconds.toFixed(1)} s`,
    }
  }

  describe(): UnitDescription {
    const { centerHz, sampleRate } = this.rec.layout
    return {
      params: [
        { key: 'centerHz', label: 'center', unit: 'Hz', min: centerHz, max: centerHz, default: centerHz },
        {
          key: 'sampleRate',
          label: 'sample rate',
          unit: 'sps',
          min: sampleRate,
          max: sampleRate,
          choices: [sampleRate],
          default: sampleRate,
        },
        descriptor.params[2],
      ],
    }
  }

  async configure(params: Record<string, number>): Promise<void> {
    const { centerHz, sampleRate } = this.rec.layout
    if (params.centerHz !== undefined && Math.abs(params.centerHz - centerHz) > 1) {
      throw new Error(`this recording sits at ${fmtMhz(centerHz)} and cannot be retuned.`)
    }
    if (params.sampleRate !== undefined && Math.abs(params.sampleRate - sampleRate) > 1) {
      throw new Error(`this recording was taken at ${Math.round(sampleRate)} sps and plays only at that rate.`)
    }
    if (params.loop !== undefined) this.loop = params.loop
  }

  async start(mode: string): Promise<void> {
    if (mode !== 'iq' && mode !== 'rx' && mode !== 'spectrum') {
      throw new Error(`a recording has no ${mode} mode. it plays iq.`)
    }
    if (this.timer) return
    const { dataOffset, dataBytes } = this.rec.layout
    // a recording that played to its end starts again from the top.
    if (this.offset >= dataOffset + dataBytes) this.offset = dataOffset
    this.startedAt = performance.now()
    this.played = 0
    this.timer = setInterval(() => void this.tick(), TICK_MS)
    this.ctx.log(`playing ${this.rec.file.name}`)
  }

  /** Emits what the clock says is due, from the file, in rtl-sdr sized chunks. */
  private async tick(): Promise<void> {
    if (this.reading) return
    this.reading = true
    try {
      const { layout } = this.rec
      const due = ((performance.now() - this.startedAt) / 1000) * layout.sampleRate
      let owed = Math.min(due - this.played, layout.sampleRate * MAX_CATCH_UP_S)
      // a tab that slept skips what it missed rather than replaying it all at
      // once, and says so in the dropped count the way a radio would.
      if (due - this.played > owed) {
        this.skipped += Math.floor(due - this.played - owed)
        this.played = due - owed
      }
      while (owed >= this.chunk && this.timer) {
        const chunk = await this.read(this.chunk)
        if (!chunk || !this.timer) break
        this.emit(chunk)
        this.played += this.chunk
        owed -= this.chunk
      }
    } catch (err) {
      await this.end(`playback stopped: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.reading = false
    }
  }

  /** The next n complex samples, wrapping at the end when looping. Null at the end otherwise. */
  private async read(n: number): Promise<Float32Array | null> {
    const { file, layout } = this.rec
    const end = layout.dataOffset + layout.dataBytes
    const want = n * SAMPLE_BYTES[layout.format]
    if (this.offset >= end) {
      if (!this.loop) {
        await this.end('end of the recording')
        return null
      }
      this.offset = layout.dataOffset
    }
    const stop = Math.min(end, this.offset + want)
    const bytes = new Uint8Array(await file.slice(this.offset, stop).arrayBuffer())
    this.offset = stop
    return toFloats(bytes, layout.format)
  }

  private emit(samples: Float32Array): void {
    const { centerHz, sampleRate } = this.rec.layout
    const iq: Omit<IqChunk, 'source' | 'seq' | 't' | 'wall'> = {
      kind: 'iq',
      samples,
      centerHz,
      sampleRate,
      dropped: this.skipped,
    }
    this.skipped = 0
    this.ctx.emit(iq)
    const now = performance.now()
    if (now - this.lastFft < FFT_MIN_INTERVAL_MS || samples.length < FFT_SIZE * 2) return
    this.lastFft = now
    const frame: Omit<FftFrame, 'source' | 'seq' | 't' | 'wall'> = {
      kind: 'fft',
      bins: this.analyzer.process(samples).slice(),
      centerHz,
      sampleRate,
    }
    this.ctx.emit(frame)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Stops on the session's own account, and tells the bus it is no longer streaming. */
  private async end(reason: string): Promise<void> {
    await this.stop()
    this.ctx.stopped?.(reason)
  }

  async resetToSafeState(): Promise<void> {
    await this.stop()
  }

  async close(): Promise<void> {
    await this.stop()
  }

  async health(): Promise<boolean> {
    return true
  }
}

/** A typed field wins over what the file says, since the person typing knows the recording. */
function fieldHz(text: string | undefined, what: string): number | undefined {
  if (!text?.trim()) return undefined
  const hz = parseFrequency(text)
  if (hz === null || hz <= 0) throw new Error(`${text} is not a ${what}. try something like 2.4m.`)
  return hz
}

export const iqFileDriver: DeviceDriver = {
  descriptor,

  async requestAccess(transport: TransportKind, fields?: Record<string, string>): Promise<DeviceHandle | null> {
    if (transport !== 'file') throw new Error('a recording opens from a file')
    const typedCenter = fieldHz(fields?.center, 'frequency')
    const typedRate = fieldHz(fields?.rate, 'sample rate')
    const file = await pickFile(IQ_EXTENSIONS, 'iq recordings')
    if (!file) return null
    const head = new DataView(await file.slice(0, HEAD_BYTES).arrayBuffer())
    const layout = layoutOf(file.name, head, file.size)
    if (layout.dataBytes < SAMPLE_BYTES[layout.format]) {
      throw new Error(`${file.name} holds no samples.`)
    }
    const centerHz = typedCenter ?? layout.centerHz
    const sampleRate = typedRate ?? layout.sampleRate
    if (!sampleRate) {
      throw new Error(`${file.name} says nothing about its sample rate. type it in the rate field, like 2.4m.`)
    }
    if (!centerHz) {
      throw new Error(`${file.name} says nothing about its centre. type it in the centre field, like 1090m.`)
    }
    const rec: Recording = { file, layout: { ...layout, centerHz, sampleRate } }
    return {
      kind: descriptor.kind,
      transport: 'file',
      uid: `${file.name}:${file.size}`,
      label: file.name.length > 28 ? `${file.name.slice(0, 25)}...` : file.name,
      raw: rec,
    }
  },

  async open(handle: DeviceHandle, ctx: DriverContext): Promise<DeviceSession> {
    const session = new IqFileSession(handle.raw as Recording, ctx)
    ctx.setInfo(session.getInfo())
    return session
  },
}

import { CAPABILITIES } from '@/core/capabilities'
import type { Capability } from '@/core/capabilities'
import { SpectrumAnalyzer } from '@/core/dsp/fft'
import type { DeviceDescriptor, TransportKind } from '@/core/types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '../types'

/**
 * A synthetic radio, so the bench can be used and demonstrated with no
 * hardware attached.
 *
 * It produces the same artifacts a real receiver does: IQ chunks with a few
 * carriers in them, FFT frames, demodulated audio, and occasional packets.
 * Every panel that works against this works against real hardware, because
 * neither one is talking to the panel directly.
 */

const SIGNALS = [
  { offsetHz: -420e3, amplitude: 0.35, toneHz: 600 },
  { offsetHz: 90e3, amplitude: 0.6, toneHz: 440 },
  { offsetHz: 610e3, amplitude: 0.22, toneHz: 880 },
]

const descriptor: DeviceDescriptor = {
  kind: 'sim',
  name: 'simulated radio',
  blurb: 'a fake receiver for trying the bench with nothing plugged in',
  icon: 'flask',
  transports: ['sim'],
  capabilities: [
    CAPABILITIES.OBSERVE_SPECTRUM,
    CAPABILITIES.CAPTURE_IQ,
    CAPABILITIES.AUDIO_DEMOD,
    CAPABILITIES.CAPTURE_PACKET,
  ],
  params: [
    {
      key: 'centerHz',
      label: 'center',
      unit: 'Hz',
      min: 24e6,
      max: 1766e6,
      default: 100.3e6,
      log: true,
    },
    {
      key: 'sampleRate',
      label: 'sample rate',
      unit: 'sps',
      min: 2048000,
      max: 3200000,
      choices: [2048000, 2400000, 3200000],
      default: 2400000,
    },
    { key: 'gain', label: 'gain', unit: 'dB', min: 0, max: 49, default: 49 },
    { key: 'volume', label: 'volume', min: 0, max: 100, default: 72 },
    { key: 'squelch', label: 'squelch', unit: 'dB', min: -100, max: 0, default: -100 },
    { key: 'ppm', label: 'ppm', min: -100, max: 100, default: 0 },
  ],
  limits: {
    [CAPABILITIES.TRANSMIT_RF]:
      'nothing here reaches an antenna. the simulated radio only produces samples.',
  },
}

class SimSession implements DeviceSession {
  private ctx: DriverContext
  private timer: ReturnType<typeof setInterval> | null = null
  private analyzer = new SpectrumAnalyzer(2048)
  private params: Record<string, number> = {}
  private phase = 0
  private packetTick = 0

  constructor(ctx: DriverContext) {
    this.ctx = ctx
  }

  getCapabilities(): Capability[] {
    return descriptor.capabilities
  }

  getInfo(): Record<string, string> {
    return { tuner: 'none, synthetic', serial: 'sim-0001', firmware: 'built in' }
  }

  async configure(params: Record<string, number>): Promise<void> {
    this.params = { ...this.params, ...params }
  }

  async start(mode: string): Promise<void> {
    if (this.timer) return
    const rate = this.params.sampleRate ?? 2400000
    const chunkSamples = 4096

    this.ctx.log(`simulated ${mode} started at ${rate} sps`)

    this.timer = setInterval(() => {
      if (this.ctx.signal.aborted) return

      const iq = new Float32Array(chunkSamples * 2)
      const step = (2 * Math.PI) / rate

      for (let i = 0; i < chunkSamples; i++) {
        let re = 0
        let im = 0
        for (const s of SIGNALS) {
          // a carrier at the offset, amplitude modulated by an audio tone so
          // the demodulators have something to recover.
          const t = this.phase + i
          const mod = 0.5 + 0.5 * Math.sin(step * s.toneHz * t * 40)
          const angle = step * s.offsetHz * t
          re += Math.cos(angle) * s.amplitude * mod
          im += Math.sin(angle) * s.amplitude * mod
        }
        re += (Math.random() - 0.5) * 0.06
        im += (Math.random() - 0.5) * 0.06
        iq[i * 2] = re
        iq[i * 2 + 1] = im
      }
      this.phase += chunkSamples

      const centerHz = this.params.centerHz ?? 100.3e6

      this.ctx.emit({
        kind: 'iq',
        samples: iq,
        centerHz,
        sampleRate: rate,
        dropped: 0,
      })

      this.ctx.emit({
        kind: 'fft',
        bins: this.analyzer.process(iq).slice(),
        centerHz,
        sampleRate: rate,
      })

      // a frame every couple of seconds, so the packet panels have traffic.
      if (++this.packetTick % 30 === 0) {
        const bytes = new Uint8Array(9)
        crypto.getRandomValues(bytes)
        this.ctx.emit({
          kind: 'packet',
          bytes,
          proto: 'ism',
          rssi: -40 - Math.floor(Math.random() * 40),
          fields: { address: `sim:${bytes[0].toString(16).padStart(2, '0')}`, bits: 24 },
          summary: 'simulated ook frame',
        })
      }
    }, 60)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
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

export const simDriver: DeviceDriver = {
  descriptor,

  availableTransports(): TransportKind[] {
    return ['sim']
  },

  async requestAccess(): Promise<DeviceHandle | null> {
    return {
      kind: 'sim',
      transport: 'sim',
      uid: 'sim-0001',
      label: 'simulated radio',
      raw: null,
    }
  },

  async open(_handle: DeviceHandle, ctx: DriverContext): Promise<DeviceSession> {
    ctx.setInfo({ note: 'synthetic samples, nothing is on the air' })
    return new SimSession(ctx)
  },
}

/**
 * ISM band sensor decoding from IQ, after rtl_433.
 *
 * The chain is rtl_433's: 8 bit IQ, envelope and FM discriminator in fixed
 * point, an OOK burst detector that tracks the noise floor and times an FSK
 * signal inside a burst, then one slicer per protocol and the protocol's own
 * checks. The decoder is a port of rtl_433 (github.com/merbanan/rtl_433),
 * which is GPL-2.0-or-later, and is a derivative work of it.
 *
 * Input is the bench's float IQ in -1 to 1. It is brought back to the 8 bit
 * scale an RTL-SDR delivers, because the detector's thresholds are set in
 * that scale.
 */

import { Baseband } from './baseband'
import { BitBuffer } from './bitbuffer'
import { PULSE_FSK, PULSE_NONE, PULSE_OOK, PulseDetector } from './pulseDetect'
import type { DetectLevels, FskMode } from './pulseDetect'
import { SLICERS } from './slicers'
import { ismProtocols } from './registry'
import { newPulseData } from './types'
import type { FieldValue, IsmMessage, IsmProtocol, PulseData } from './types'

export interface IsmDecoded {
  id: number
  /** Seconds since the decoder started, from the sample count. */
  at: number
  mod: 'ook' | 'fsk'
  protocol: string
  model: string
  fields: Record<string, FieldValue>
  bytes: Uint8Array
  rssiDb: number
  snrDb: number
  /** Carrier offset from the tuned centre, Hz. */
  offsetHz: number
}

export interface IsmUnknown {
  id: number
  at: number
  mod: 'ook' | 'fsk'
  /** Pulse and gap widths in microseconds, as many as were kept. */
  pulsesUs: number[]
  gapsUs: number[]
  /** Pulses in the burst, which may be more than were kept. */
  count: number
  rssiDb: number
  snrDb: number
  offsetHz: number
}

export interface IsmStats {
  samples: number
  bursts: number
  decoded: number
  unknown: number
}

export interface IsmDecoderOptions {
  /** 'auto' picks min max above 800 MHz, as rtl_433 does when it tunes there. */
  fsk?: FskMode | 'auto'
  levels?: DetectLevels
  /** Bursts with fewer pulses than this are dropped from the unknown view. */
  unknownMinPulses?: number
  /** Pulses kept per unknown burst. */
  unknownKeep?: number
}

const FAMILY: Record<IsmProtocol['modulation'], 'ook' | 'fsk'> = {
  ook_pcm: 'ook',
  ook_ppm: 'ook',
  ook_pwm: 'ook',
  ook_manchester: 'ook',
  fsk_pcm: 'fsk',
  fsk_pwm: 'fsk',
  fsk_manchester: 'fsk',
}

const SLICER_OF: Record<IsmProtocol['modulation'], keyof typeof SLICERS> = {
  ook_pcm: 'pcm',
  ook_ppm: 'ppm',
  ook_pwm: 'pwm',
  ook_manchester: 'manchester',
  fsk_pcm: 'pcm',
  fsk_pwm: 'pwm',
  fsk_manchester: 'manchester',
}

const AMP_FS_DB = 42.1442
const OOK_MAX_HIGH = 16384

function hex(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0')
  return s
}

export class IsmDecoder {
  onMessage: ((m: IsmDecoded) => void) | null = null
  onUnknown: ((u: IsmUnknown) => void) | null = null

  readonly stats: IsmStats = { samples: 0, bursts: 0, decoded: 0, unknown: 0 }

  private baseband = new Baseband()
  private detector: PulseDetector
  private ook = newPulseData()
  private fsk = newPulseData()
  private bits = new BitBuffer()
  private u8 = new Uint8Array(0)
  private env = new Int16Array(0)
  private fm = new Int16Array(0)
  private tmp = new Uint16Array(0)
  private rate = 0
  private centerHz = 0
  private seq = 0
  private lastDb = -AMP_FS_DB
  private tiers: IsmProtocol[][] = []
  private opts: Required<Omit<IsmDecoderOptions, 'levels'>>

  constructor(opts: IsmDecoderOptions = {}) {
    this.detector = new PulseDetector(opts.levels)
    this.opts = {
      fsk: opts.fsk ?? 'auto',
      unknownMinPulses: opts.unknownMinPulses ?? 8,
      unknownKeep: opts.unknownKeep ?? 96,
    }
    this.loadProtocols()
  }

  /** Re-reads the registry, for protocols registered after construction. */
  loadProtocols(): void {
    const byTier = new Map<number, IsmProtocol[]>()
    for (const p of ismProtocols()) {
      const t = p.priority ?? 0
      if (!byTier.has(t)) byTier.set(t, [])
      byTier.get(t)!.push(p)
    }
    this.tiers = [...byTier.keys()].sort((a, b) => a - b).map((k) => byTier.get(k)!)
  }

  /** Mean block power in dB full scale, the level the squelch would see. */
  get levelDb(): number {
    return this.lastDb
  }

  /** The detector's noise floor estimate in dB full scale. */
  get noiseDb(): number {
    const n = this.detector.noiseLevel
    return n > 0 ? 10 * Math.log10(n) - AMP_FS_DB : -AMP_FS_DB
  }

  reset(): void {
    this.baseband.reset()
    this.detector.reset()
    this.stats.samples = 0
    this.stats.bursts = 0
    this.stats.decoded = 0
    this.stats.unknown = 0
  }

  private fskMode(): FskMode {
    if (this.opts.fsk !== 'auto') return this.opts.fsk
    return this.centerHz > 800e6 ? 'minmax' : 'classic'
  }

  private ensure(n: number): void {
    if (this.env.length >= n) return
    this.u8 = new Uint8Array(n * 2)
    this.env = new Int16Array(n)
    this.fm = new Int16Array(n)
    this.tmp = new Uint16Array(n)
  }

  /** Float IQ, interleaved, as the bus carries it. */
  feed(iq: Float32Array, sampleRate: number, centerHz: number): void {
    const n = iq.length >> 1
    this.ensure(n)
    const u8 = this.u8
    for (let i = 0; i < n * 2; i++) {
      const v = Math.round(iq[i] * 127.5 + 127.5)
      u8[i] = v < 0 ? 0 : v > 255 ? 255 : v
    }
    this.run(u8, n, sampleRate, centerHz)
  }

  /** Raw 8 bit IQ, as an RTL-SDR or a .cu8 file delivers it. */
  feedU8(iq: Uint8Array, sampleRate: number, centerHz: number): void {
    const n = iq.length >> 1
    this.ensure(n)
    this.run(iq, n, sampleRate, centerHz)
  }

  /** Runs a block of carrier off, which closes a burst left open at the end of the input. */
  flush(): void {
    if (!this.rate) return
    const n = 131072
    const z = new Uint8Array(n * 2).fill(128)
    this.ensure(n)
    this.run(z, n, this.rate, this.centerHz)
  }

  private run(iq: Uint8Array, n: number, rate: number, centerHz: number): void {
    if (rate !== this.rate || centerHz !== this.centerHz) {
      if (this.rate) {
        this.baseband.reset()
        this.detector.reset()
      }
      this.rate = rate
      this.centerHz = centerHz
    }
    const mode = this.fskMode()
    this.lastDb = this.baseband.envelope(iq, n, this.env, this.tmp)
    this.baseband.fm(iq, n, this.fm, rate, mode === 'classic' ? 0.1 : 0.2)
    const offset = this.stats.samples
    for (;;) {
      const kind = this.detector.detect(this.env, this.fm, n, rate, offset, this.ook, this.fsk, mode)
      if (kind === PULSE_NONE) break
      this.stats.bursts++
      if (kind === PULSE_OOK) this.dispatch(this.ook, 'ook')
      else if (kind === PULSE_FSK) this.dispatch(this.fsk, 'fsk')
    }
    this.stats.samples += n
  }

  private dispatch(p: PulseData, mod: 'ook' | 'fsk'): void {
    const high = p.ookHigh
    const low = p.ookLow > 0 ? p.ookLow : 1
    const rssiDb = high > 0 ? 10 * Math.log10(high) - AMP_FS_DB : -AMP_FS_DB
    const snrDb = 10 * Math.log10(Math.min(high, OOK_MAX_HIGH) / low)
    const fmMean = mod === 'fsk' ? (p.fskF1 + p.fskF2) / 2 : p.fskF1
    const offsetHz = (fmMean / 32767) * (p.sampleRate / 2)
    const at = p.offset / p.sampleRate

    let events = 0
    for (const tier of this.tiers) {
      for (const proto of tier) {
        if (FAMILY[proto.modulation] !== mod) continue
        const slice = SLICERS[SLICER_OF[proto.modulation]]
        events += slice(p, proto, this.bits, (m: IsmMessage, bits: BitBuffer) => {
          this.stats.decoded++
          this.onMessage?.({
            id: ++this.seq,
            at,
            mod,
            protocol: proto.id,
            model: m.model,
            fields: m.fields,
            bytes: m.bytes ?? bits.rows[0].slice(0, (bits.bits[0] + 7) >> 3),
            rssiDb,
            snrDb,
            offsetHz,
          })
        })
      }
      if (events) return
    }
    if (p.num < this.opts.unknownMinPulses) return
    this.stats.unknown++
    if (!this.onUnknown) return
    const keep = Math.min(p.num, this.opts.unknownKeep)
    const us = 1e6 / p.sampleRate
    const pulsesUs: number[] = []
    const gapsUs: number[] = []
    for (let i = 0; i < keep; i++) {
      pulsesUs.push(Math.round(p.pulse[i] * us))
      gapsUs.push(Math.round(p.gap[i] * us))
    }
    this.onUnknown({ id: ++this.seq, at, mod, pulsesUs, gapsUs, count: p.num, rssiDb, snrDb, offsetHz })
  }
}

export { hex as bytesToHex }

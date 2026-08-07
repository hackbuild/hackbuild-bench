/**
 * Transmit side modulators. The mirror of demod.ts.
 *
 * Every function here returns interleaved I,Q at the transmit sample rate,
 * scaled so the peak sits below full scale. Audio arrives at whatever rate it
 * was decoded or captured at, so each path resamples first: a radio only runs
 * at its own rate.
 *
 * The classes hold phase and resampler state between calls, which is what a
 * long transmission needs. The plain functions build one whole buffer and are
 * only safe for short pieces, since one second of IQ at 2 Msps is 16 MB.
 */

const TWO_PI = Math.PI * 2

/** Peak baseband amplitude. The rest is headroom before the transmit dac clips. */
export const TX_PEAK = 0.75

function clamp1(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v
}

function wrap(phase: number): number {
  let p = phase
  while (p > TWO_PI) p -= TWO_PI
  while (p < -TWO_PI) p += TWO_PI
  return p
}

// ---------------------------------------------------------------------------
// resampling
// ---------------------------------------------------------------------------

/**
 * Linear resampler for mono audio that survives being fed in blocks. The
 * fractional read position and the last input sample carry across calls, so
 * block boundaries produce no click.
 */
export class AudioResampler {
  private readonly ratio: number
  private pos = 0
  private prev = 0

  constructor(fromRate: number, toRate: number) {
    this.ratio = fromRate > 0 && toRate > 0 ? fromRate / toRate : 1
  }

  process(input: Float32Array): Float32Array {
    if (input.length === 0) return new Float32Array(0)
    if (this.ratio === 1) {
      this.prev = input[input.length - 1]
      return input
    }

    const last = input.length - 1
    const outLen = this.pos > last ? 0 : Math.floor((last - this.pos) / this.ratio) + 1
    const out = new Float32Array(outLen)
    for (let o = 0; o < outLen; o++) {
      const src = this.pos + o * this.ratio
      const i = Math.floor(src)
      const frac = src - i
      const a = i < 0 ? this.prev : input[i]
      const b = i + 1 <= last ? input[i + 1] : a
      out[o] = a + (b - a) * frac
    }

    this.pos = this.pos + outLen * this.ratio - input.length
    this.prev = input[last]
    return out
  }
}

/** One shot audio resample. Use AudioResampler when the audio arrives in blocks. */
export function resampleAudio(
  audio: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return audio
  return new AudioResampler(fromRate, toRate).process(audio)
}

/** Linear resample of interleaved IQ, used when a buffer was built off rate. */
export function resampleIq(iq: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || fromRate <= 0 || toRate <= 0) return iq
  const inFrames = Math.floor(iq.length / 2)
  if (inFrames < 2) return iq

  const ratio = fromRate / toRate
  const outFrames = Math.max(1, Math.floor((inFrames - 1) / ratio) + 1)
  const out = new Float32Array(outFrames * 2)
  for (let o = 0; o < outFrames; o++) {
    const src = o * ratio
    const i = Math.min(inFrames - 1, Math.floor(src))
    const j = Math.min(inFrames - 1, i + 1)
    const frac = src - i
    out[o * 2] = iq[i * 2] + (iq[j * 2] - iq[i * 2]) * frac
    out[o * 2 + 1] = iq[i * 2 + 1] + (iq[j * 2 + 1] - iq[i * 2 + 1]) * frac
  }
  return out
}

// ---------------------------------------------------------------------------
// carriers and tones
// ---------------------------------------------------------------------------

/** A complex exponential at a fixed offset from the tuned frequency. */
export class ToneSource {
  private phase = 0
  private readonly step: number
  private readonly peak: number

  constructor(freqHz: number, sampleRate: number, peak = TX_PEAK) {
    this.step = sampleRate > 0 ? (TWO_PI * freqHz) / sampleRate : 0
    this.peak = peak
  }

  /** `count` complex samples, interleaved. */
  take(count: number): Float32Array {
    const out = new Float32Array(Math.max(0, count) * 2)
    for (let i = 0; i < count; i++) {
      out[i * 2] = Math.cos(this.phase) * this.peak
      out[i * 2 + 1] = Math.sin(this.phase) * this.peak
      this.phase = wrap(this.phase + this.step)
    }
    return out
  }
}

/** A test tone carrier, offset from the tuned frequency by freqHz. */
export function toneIq(freqHz: number, seconds: number, sampleRate: number): Float32Array {
  const count = Math.max(0, Math.round(seconds * sampleRate))
  return new ToneSource(freqHz, sampleRate).take(count)
}

// ---------------------------------------------------------------------------
// analogue modulation
// ---------------------------------------------------------------------------

/**
 * Frequency modulation. The audio drives the phase, so the instantaneous
 * offset from the carrier is audio times the deviation. 75 kHz is broadcast
 * fm, 5 kHz is the narrow fm used on the voice bands.
 */
export class FmModulator {
  private readonly resampler: AudioResampler
  private readonly step: number
  private readonly peak: number
  private phase = 0

  constructor(audioRate: number, sampleRate: number, deviationHz: number, peak = TX_PEAK) {
    this.resampler = new AudioResampler(audioRate, sampleRate)
    this.step = sampleRate > 0 ? (TWO_PI * deviationHz) / sampleRate : 0
    this.peak = peak
  }

  process(audio: Float32Array): Float32Array {
    const a = this.resampler.process(audio)
    const out = new Float32Array(a.length * 2)
    for (let i = 0; i < a.length; i++) {
      this.phase = wrap(this.phase + this.step * clamp1(a[i]))
      out[i * 2] = Math.cos(this.phase) * this.peak
      out[i * 2 + 1] = Math.sin(this.phase) * this.peak
    }
    return out
  }
}

export function fmModulate(
  audio: Float32Array,
  audioRate: number,
  sampleRate: number,
  deviationHz: number,
): Float32Array {
  return new FmModulator(audioRate, sampleRate, deviationHz).process(audio)
}

/**
 * Amplitude modulation with the carrier left in, which is what an am receiver
 * envelope detector expects. The modulation index stays under one so the
 * envelope never crosses zero and inverts.
 */
export class AmModulator {
  private readonly resampler: AudioResampler
  private readonly peak: number
  private readonly index: number

  constructor(audioRate: number, sampleRate: number, index = 0.85, peak = TX_PEAK) {
    this.resampler = new AudioResampler(audioRate, sampleRate)
    this.index = Math.min(1, Math.max(0, index))
    this.peak = peak
  }

  process(audio: Float32Array): Float32Array {
    const a = this.resampler.process(audio)
    const out = new Float32Array(a.length * 2)
    for (let i = 0; i < a.length; i++) {
      out[i * 2] = (1 + this.index * clamp1(a[i])) * 0.5 * this.peak
      out[i * 2 + 1] = 0
    }
    return out
  }
}

export function amModulate(
  audio: Float32Array,
  audioRate: number,
  sampleRate: number,
): Float32Array {
  return new AmModulator(audioRate, sampleRate).process(audio)
}

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

/** Bytes as a bit array, most significant bit first unless told otherwise. */
export function bytesToBits(bytes: Uint8Array, msbFirst = true): number[] {
  const bits: number[] = []
  for (const byte of bytes) {
    for (let i = 0; i < 8; i++) {
      const shift = msbFirst ? 7 - i : i
      bits.push((byte >> shift) & 1)
    }
  }
  return bits
}

export interface OokOptions {
  peak?: number
  /** Rise and fall time of each keying edge. Square edges splatter. */
  edgeSeconds?: number
}

/**
 * On off keying at baseband. The carrier sits at the tuned frequency and the
 * bits switch it, which is what garage remotes, doorbells and most of the 433
 * MHz band do.
 */
export function ookFrame(
  bits: number[],
  bitRate: number,
  sampleRate: number,
  opts: OokOptions = {},
): Float32Array {
  const perBit = Math.max(1, Math.round(sampleRate / Math.max(1, bitRate)))
  const peak = opts.peak ?? TX_PEAK
  const edge = Math.max(
    1,
    Math.min(Math.floor(perBit / 4), Math.round((opts.edgeSeconds ?? 20e-6) * sampleRate)),
  )

  const out = new Float32Array(bits.length * perBit * 2)
  let prev = 0
  for (let b = 0; b < bits.length; b++) {
    const on = bits[b] ? 1 : 0
    for (let i = 0; i < perBit; i++) {
      let amp = on
      if (i < edge && on !== prev) {
        const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / edge)
        amp = prev + (on - prev) * w
      }
      const idx = (b * perBit + i) * 2
      out[idx] = amp * peak
      out[idx + 1] = 0
    }
    prev = on
  }
  return out
}

export interface AfskOptions {
  /** Tone for a one bit. Bell 202 uses 1200 Hz. */
  mark?: number
  /** Tone for a zero bit. Bell 202 uses 2200 Hz. */
  space?: number
  baud?: number
  /** Rate the tone stream is built at before it is modulated. */
  audioRate?: number
  /** Peak deviation used when the tones go out as fm. */
  deviationHz?: number
  /** Alternating bits sent first so a receiver can lock its clock. */
  preambleBits?: number
  msbFirst?: boolean
}

/** The audio a bell 202 modem puts on a phone line or into an fm transmitter. */
export function afskAudio(
  bytes: Uint8Array,
  audioRate: number,
  opts: AfskOptions = {},
): Float32Array {
  const mark = opts.mark ?? 1200
  const space = opts.space ?? 2200
  const baud = Math.max(1, opts.baud ?? 1200)
  const preamble = Math.max(0, opts.preambleBits ?? 32)

  const bits: number[] = []
  for (let i = 0; i < preamble; i++) bits.push(i % 2)
  for (const bit of bytesToBits(bytes, opts.msbFirst ?? true)) bits.push(bit)

  const perBit = audioRate / baud
  const out = new Float32Array(Math.ceil(bits.length * perBit) + 1)
  let phase = 0
  let cursor = 0
  let end = 0
  for (const bit of bits) {
    const step = (TWO_PI * (bit ? mark : space)) / audioRate
    const start = Math.round(cursor)
    cursor += perBit
    end = Math.min(Math.round(cursor), out.length)
    for (let i = start; i < end; i++) {
      out[i] = Math.sin(phase) * 0.9
      phase = wrap(phase + step)
    }
  }
  return out.subarray(0, end)
}

/**
 * Bell 202 tones carried as fm, which is how a handheld sends packet data.
 * The tones are built at an audio rate, then modulated up to the radio rate.
 */
export function afskModulate(
  bytes: Uint8Array,
  sampleRate: number,
  opts: AfskOptions = {},
): Float32Array {
  const audioRate = opts.audioRate ?? 48000
  const audio = afskAudio(bytes, audioRate, opts)
  return fmModulate(audio, audioRate, sampleRate, opts.deviationHz ?? 3000)
}

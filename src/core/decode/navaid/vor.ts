/**
 * VOR and ILS navigation beacons, decoded from an AM airband channel.
 *
 * A VOR (108 to 117.95 MHz) tells an aircraft its bearing from the station.
 * After AM detection the audio carries two 30 Hz tones: a "variable" 30 Hz
 * that the antenna pattern sweeps round the compass, and a "reference" 30 Hz
 * carried as FM on a 9960 Hz subcarrier. Their phase difference is the
 * radial, the direction from the station to the aircraft. A 1020 Hz tone
 * keys the station's morse ident.
 *
 * An ILS localizer (108.1 to 111.95 MHz) and glideslope (329 to 335 MHz)
 * carry 90 Hz and 150 Hz tones instead. Which is stronger says which side of
 * the centreline the aircraft is on; equal is on course. The difference in
 * their depth of modulation (DDM) is the needle.
 *
 * The maths follows the standard (ICAO Annex 10) as decoders like the GNU
 * Radio VOR receivers implement it.
 */

import { ChannelFilter } from '@/core/dsp/channel'
import { morseToText } from './morse'

/** Output rate of the channel filter: wide enough for the 9960 Hz subcarrier. */
const AUDIO_RATE = 48000
/** Half the channel kept, past the subcarrier and its 480 Hz deviation. */
const CHANNEL_HALF_HZ = 12000
const SUBCARRIER_HZ = 9960
/** A result is produced this often, over a window this long. */
const WINDOW_S = 0.5

export type NavKind = 'vor' | 'ils' | 'unknown'

export interface NavResult {
  kind: NavKind
  /** Carrier strength, a rough signal present measure. */
  level: number
  /** Degrees from the station, 0 to 360, for a vor. Null until locked. */
  radial: number | null
  /** How cleanly the two 30 Hz tones were recovered, 0 to 1. */
  vorQuality: number
  /** Localizer or glideslope difference in depth of modulation, -0.4 to 0.4. */
  ddm: number | null
  /** The 90 and 150 Hz modulation depths, for display. */
  depth90: number
  depth150: number
  /** Decoded morse ident, such as PHX, once heard. */
  ident: string
}

/** A running quadrature correlator at one frequency, giving amplitude and phase. */
class Tone {
  private re = 0
  private im = 0
  private n = 0
  private phase = 0
  private readonly step: number

  constructor(freq: number, rate: number) {
    this.step = (2 * Math.PI * freq) / rate
  }

  push(x: number): void {
    this.re += x * Math.cos(this.phase)
    this.im += x * Math.sin(this.phase)
    this.phase += this.step
    if (this.phase > Math.PI) this.phase -= 2 * Math.PI
    this.n++
  }

  reset(): void {
    this.re = 0
    this.im = 0
    this.n = 0
  }

  /** Peak amplitude of the tone over the window. */
  get amplitude(): number {
    return this.n ? (2 * Math.hypot(this.re, this.im)) / this.n : 0
  }

  /** Phase of the tone, radians. */
  get angle(): number {
    return Math.atan2(this.im, this.re)
  }
}

/** A one pole bandpass, as two cascaded one pole sections around a centre. */
class BandPass {
  private hpA = 0
  private lpA = 0
  private lpB = 0
  private readonly rc: number

  constructor(
    private readonly centre: number,
    private readonly rate: number,
    halfWidth: number,
  ) {
    this.rc = halfWidth
  }

  // mixes to zero, low passes, and the caller takes the magnitude envelope.
  private phase = 0
  envelope(x: number): number {
    const c = Math.cos(this.phase)
    const s = Math.sin(this.phase)
    this.phase += (2 * Math.PI * this.centre) / this.rate
    if (this.phase > Math.PI) this.phase -= 2 * Math.PI
    const i = x * c
    const q = x * s
    const a = 1 - Math.exp((-2 * Math.PI * this.rc) / this.rate)
    this.lpA += a * (i - this.lpA)
    this.lpB += a * (q - this.lpB)
    void this.hpA
    return 2 * Math.hypot(this.lpA, this.lpB)
  }
}

export class VorIlsDecoder {
  onResult: ((r: NavResult) => void) | null = null

  private filter: ChannelFilter | null = null
  private inputRate = 0
  private offset = 0

  // dc block for the AM envelope.
  private dc = 0
  // 30 Hz variable, from the envelope.
  private var30: Tone
  // 90 and 150 Hz, for ils.
  private t90: Tone
  private t150: Tone
  private carrier = 0
  private envRms = 0

  // the 9960 subcarrier, mixed to zero and fm demodulated for the reference.
  private subPhase = 0
  private subI = 0
  private subQ = 0
  private prevSubI = 1
  private prevSubQ = 0
  private ref30: Tone
  private subRate = AUDIO_RATE

  // 1020 Hz ident tone envelope, for morse.
  private identBp: BandPass
  private identEnv = 0
  private morse = ''
  private keyOn = false
  private keyMs = 0
  private gapMs = 0
  private ident = ''
  private readonly msPerSample: number

  private samples = 0
  private windowSamples = 0
  /**
   * The fixed phase the decoder's own filters and discriminator add between
   * the variable and reference paths, taken out so a radial reads true. It
   * is a property of the processing, not the signal, so it is the same for
   * the demo and for a real station. A field adjust is exposed for the
   * cvor/dvor sense and any residual.
   */
  calibrationDeg = 172.7

  constructor() {
    this.var30 = new Tone(30, AUDIO_RATE)
    this.t90 = new Tone(90, AUDIO_RATE)
    this.t150 = new Tone(150, AUDIO_RATE)
    this.ref30 = new Tone(30, AUDIO_RATE)
    this.identBp = new BandPass(1020, AUDIO_RATE, 50)
    this.msPerSample = 1000 / AUDIO_RATE
    this.windowSamples = Math.round(AUDIO_RATE * WINDOW_S)
  }

  setOffset(hz: number): void {
    if (hz === this.offset && this.filter) return
    this.offset = hz
    this.rebuild()
  }

  private rebuild(): void {
    if (!this.inputRate) return
    this.filter = new ChannelFilter(this.offset, this.inputRate, CHANNEL_HALF_HZ, AUDIO_RATE)
    this.subRate = this.filter.outRate
    this.var30 = new Tone(30, this.subRate)
    this.t90 = new Tone(90, this.subRate)
    this.t150 = new Tone(150, this.subRate)
    this.ref30 = new Tone(30, this.subRate)
    this.identBp = new BandPass(1020, this.subRate, 50)
    this.windowSamples = Math.round(this.subRate * WINDOW_S)
    this.samples = 0
  }

  feed(iq: Float32Array, sampleRate: number): void {
    if (sampleRate !== this.inputRate) {
      this.inputRate = sampleRate
      this.rebuild()
    }
    const f = this.filter
    if (!f) return
    for (let n = 0; n + 1 < iq.length; n += 2) {
      if (!f.push(iq[n], iq[n + 1])) continue
      this.sample(f.outI, f.outQ)
    }
  }

  private sample(i: number, q: number): void {
    // am detection is the carrier magnitude.
    const mag = Math.hypot(i, q)
    this.carrier += 0.0002 * (mag - this.carrier)
    this.dc += 0.001 * (mag - this.dc)
    const env = mag - this.dc
    this.envRms += 0.001 * (env * env - this.envRms)

    // the 30 Hz variable and the ils tones ride the envelope directly.
    this.var30.push(env)
    this.t90.push(env)
    this.t150.push(env)

    // the 9960 subcarrier: mix to zero, low pass, fm discriminate to the ref.
    const c = Math.cos(this.subPhase)
    const s = Math.sin(this.subPhase)
    this.subPhase += (2 * Math.PI * SUBCARRIER_HZ) / this.subRate
    if (this.subPhase > Math.PI) this.subPhase -= 2 * Math.PI
    const bi = env * c
    const bq = env * s
    const a = 1 - Math.exp((-2 * Math.PI * 1200) / this.subRate)
    this.subI += a * (bi - this.subI)
    this.subQ += a * (bq - this.subQ)
    // discriminator: phase change of the subcarrier is the fm reference.
    const d = Math.atan2(this.subQ * this.prevSubI - this.subI * this.prevSubQ, this.subI * this.prevSubI + this.subQ * this.prevSubQ)
    this.prevSubI = this.subI
    this.prevSubQ = this.subQ
    this.ref30.push(d)

    // ident tone envelope, keyed into morse.
    this.identEnv += 0.01 * (this.identBp.envelope(env) - this.identEnv)
    this.keyMorse()

    if (++this.samples >= this.windowSamples) this.finish()
  }

  private keyMorse(): void {
    const on = this.identEnv > Math.max(1e-4, 0.25 * Math.sqrt(Math.max(0, this.envRms)))
    this.msPer(on)
  }

  private msPer(on: boolean): void {
    const dot = 80 // about 7 wpm, typical for a navaid ident.
    if (on) {
      if (!this.keyOn && this.gapMs > dot * 2) {
        if (this.gapMs > dot * 5) this.flushIdent()
        else if (this.morse) this.morse += ' '
      }
      this.keyOn = true
      this.keyMs += this.msPerSample
      this.gapMs = 0
    } else {
      if (this.keyOn) {
        this.morse += this.keyMs > dot * 2 ? '-' : '.'
        this.keyMs = 0
      }
      this.keyOn = false
      this.gapMs += this.msPerSample
    }
  }

  private flushIdent(): void {
    const text = morseToText(this.morse.trim())
    // a clean navaid ident is two to four letters with no undecoded symbol.
    if (text.length >= 2 && text.length <= 4 && !text.includes('?')) this.ident = text
    this.morse = ''
  }

  private finish(): void {
    const varAmp = this.var30.amplitude
    const refAmp = this.ref30.amplitude
    const d90 = this.t90.amplitude
    const d150 = this.t150.amplitude
    const carrier = Math.max(1e-9, this.carrier)

    // the radial is the phase of the variable tone against the reference.
    // the reference discriminator runs the opposite way, so it is negated.
    let radial: number | null = null
    let vorQuality = 0
    if (varAmp > 0.002 * carrier && refAmp > 1e-4) {
      let deg = ((this.var30.angle - -this.ref30.angle) * 180) / Math.PI - this.calibrationDeg
      deg = ((deg % 360) + 360) % 360
      radial = deg
      vorQuality = Math.min(1, (varAmp / carrier) * 20)
    }

    const depth90 = d90 / carrier
    const depth150 = d150 / carrier
    const hasIls = depth90 > 0.02 || depth150 > 0.02
    const ddm = hasIls ? depth90 - depth150 : null
    const kind: NavKind = radial !== null && varAmp > d90 && varAmp > d150 ? 'vor' : hasIls ? 'ils' : 'unknown'

    this.onResult?.({
      kind,
      level: carrier,
      radial: kind === 'vor' ? radial : null,
      vorQuality,
      ddm,
      depth90,
      depth150,
      ident: this.ident,
    })

    this.var30.reset()
    this.ref30.reset()
    this.t90.reset()
    this.t150.reset()
    this.samples = 0
  }
}

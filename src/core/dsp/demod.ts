/**
 * Demodulators and the resampling they need. Input is interleaved IQ at the
 * device sample rate, output is mono audio at the audio context rate.
 */

export type DemodMode = 'fm' | 'nfm' | 'am' | 'usb' | 'lsb' | 'raw'

/** Simple integer decimator with a moving average anti-alias, cheap and good
 * enough for voice bandwidth work. */
export class Decimator {
  private factor: number
  private accI = 0
  private accQ = 0
  private count = 0

  constructor(factor: number) {
    this.factor = Math.max(1, Math.floor(factor))
  }

  setFactor(factor: number): void {
    this.factor = Math.max(1, Math.floor(factor))
    this.accI = this.accQ = this.count = 0
  }

  /** Returns interleaved IQ at rate/factor. */
  process(iq: Float32Array): Float32Array {
    if (this.factor === 1) return iq
    const outLen = Math.floor(iq.length / 2 / this.factor) * 2
    const out = new Float32Array(outLen)
    let o = 0
    for (let i = 0; i < iq.length; i += 2) {
      this.accI += iq[i]
      this.accQ += iq[i + 1]
      if (++this.count === this.factor) {
        if (o + 1 < outLen) {
          out[o++] = this.accI / this.factor
          out[o++] = this.accQ / this.factor
        }
        this.accI = this.accQ = this.count = 0
      }
    }
    return out.subarray(0, o)
  }
}

/** Quadrature FM discriminator. */
export class FmDemod {
  private lastI = 0
  private lastQ = 0
  private gain: number

  constructor(deviationHz = 75000, sampleRate = 240000) {
    this.gain = sampleRate / (2 * Math.PI * deviationHz)
  }

  configure(deviationHz: number, sampleRate: number): void {
    this.gain = sampleRate / (2 * Math.PI * deviationHz)
  }

  process(iq: Float32Array): Float32Array {
    const out = new Float32Array(iq.length / 2)
    for (let i = 0, o = 0; i < iq.length; i += 2, o++) {
      const ri = iq[i]
      const rq = iq[i + 1]
      // conjugate product with the previous sample gives the phase step.
      const di = ri * this.lastI + rq * this.lastQ
      const dq = rq * this.lastI - ri * this.lastQ
      out[o] = Math.atan2(dq, di) * this.gain
      this.lastI = ri
      this.lastQ = rq
    }
    return out
  }
}

/** Envelope detector with DC removal, which is what makes AM voice audible. */
export class AmDemod {
  private dc = 0

  process(iq: Float32Array): Float32Array {
    const out = new Float32Array(iq.length / 2)
    for (let i = 0, o = 0; i < iq.length; i += 2, o++) {
      const mag = Math.hypot(iq[i], iq[i + 1])
      this.dc = this.dc * 0.9995 + mag * 0.0005
      out[o] = mag - this.dc
    }
    return out
  }
}

/**
 * Single sideband by frequency shifting the wanted sideband to baseband and
 * taking the real part. Good enough for listening, not for measurement.
 */
export class SsbDemod {
  private phase = 0
  private readonly upper: boolean

  constructor(upper: boolean) {
    this.upper = upper
  }

  process(iq: Float32Array, sampleRate: number, bandwidthHz = 2700): Float32Array {
    const out = new Float32Array(iq.length / 2)
    const shift = (this.upper ? 1 : -1) * (bandwidthHz / 2)
    const step = (2 * Math.PI * shift) / sampleRate
    for (let i = 0, o = 0; i < iq.length; i += 2, o++) {
      const c = Math.cos(this.phase)
      const s = Math.sin(this.phase)
      out[o] = iq[i] * c - iq[i + 1] * s
      this.phase += step
      if (this.phase > Math.PI) this.phase -= 2 * Math.PI
      if (this.phase < -Math.PI) this.phase += 2 * Math.PI
    }
    return out
  }
}

/** One pole low pass, used as the audio de-emphasis and anti-alias stage. */
export class LowPass {
  private y = 0
  private a: number

  constructor(cutoffHz: number, sampleRate: number) {
    this.a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate)
  }

  configure(cutoffHz: number, sampleRate: number): void {
    this.a = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate)
  }

  process(x: Float32Array): Float32Array {
    for (let i = 0; i < x.length; i++) {
      this.y += this.a * (x[i] - this.y)
      x[i] = this.y
    }
    return x
  }
}

/** Linear resampler to the audio context rate. */
export class Resampler {
  private pos = 0
  private last = 0

  process(input: Float32Array, ratio: number): Float32Array {
    const outLen = Math.floor(input.length / ratio)
    const out = new Float32Array(outLen)
    for (let o = 0; o < outLen; o++) {
      const src = this.pos + o * ratio
      const i = Math.floor(src)
      const frac = src - i
      const a = i === 0 ? this.last : (input[i - 1] ?? 0)
      const b = input[i] ?? a
      out[o] = a + (b - a) * frac
    }
    this.pos = (this.pos + outLen * ratio) % 1
    this.last = input[input.length - 1] ?? this.last
    return out
  }
}

/** Automatic gain so a quiet station and a strong one are both listenable. */
export class Agc {
  private gain = 1
  private target: number
  private attack: number
  private release: number

  constructor(target = 0.25, attack = 0.02, release = 0.0008) {
    this.target = target
    this.attack = attack
    this.release = release
  }

  process(x: Float32Array): Float32Array {
    let peak = 0
    for (let i = 0; i < x.length; i++) {
      const a = Math.abs(x[i])
      if (a > peak) peak = a
    }
    if (peak > 1e-6) {
      const wanted = this.target / peak
      const rate = wanted < this.gain ? this.attack : this.release
      this.gain += (wanted - this.gain) * rate
    }
    this.gain = Math.min(this.gain, 80)
    for (let i = 0; i < x.length; i++) x[i] = Math.max(-1, Math.min(1, x[i] * this.gain))
    return x
  }
}

/**
 * The full receive chain: decimate, demodulate, filter, resample, level.
 * One instance per listening device.
 */
export class ReceiveChain {
  private decim = new Decimator(1)
  private fm = new FmDemod()
  private am = new AmDemod()
  private usb = new SsbDemod(true)
  private lsb = new SsbDemod(false)
  private lp: LowPass
  private resamp = new Resampler()
  private agc = new Agc()
  private mode: DemodMode = 'fm'
  private outRate = 48000
  private ifRate = 256000

  constructor(outRate = 48000) {
    this.outRate = outRate
    this.lp = new LowPass(8000, this.ifRate)
  }

  configure(mode: DemodMode, inputRate: number): void {
    this.mode = mode
    const wantIf = mode === 'fm' ? 256000 : 48000
    const factor = Math.max(1, Math.round(inputRate / wantIf))
    this.ifRate = inputRate / factor
    this.decim.setFactor(factor)
    this.fm.configure(mode === 'nfm' ? 5000 : 75000, this.ifRate)
    this.lp.configure(mode === 'fm' ? 15000 : 3400, this.ifRate)
  }

  /** Interleaved IQ in, mono audio at outRate out. */
  process(iq: Float32Array): Float32Array {
    if (this.mode === 'raw') return new Float32Array(0)
    const base = this.decim.process(iq)
    let audio: Float32Array
    switch (this.mode) {
      case 'fm':
      case 'nfm':
        audio = this.fm.process(base)
        break
      case 'am':
        audio = this.am.process(base)
        break
      case 'usb':
        audio = this.usb.process(base, this.ifRate)
        break
      case 'lsb':
        audio = this.lsb.process(base, this.ifRate)
        break
      default:
        return new Float32Array(0)
    }
    audio = this.lp.process(audio)
    audio = this.resamp.process(audio, this.ifRate / this.outRate)
    return this.agc.process(audio)
  }

  /** Wideband power in dB, used for the squelch and the sweep detector. */
  static power(iq: Float32Array): number {
    let sum = 0
    for (let i = 0; i < iq.length; i += 2) {
      sum += iq[i] * iq[i] + iq[i + 1] * iq[i + 1]
    }
    const mean = sum / (iq.length / 2)
    return 10 * Math.log10(mean + 1e-12)
  }
}

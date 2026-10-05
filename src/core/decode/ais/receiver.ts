/**
 * The AIS air interface, from IQ to checked frames.
 *
 * AIS is gmsk at 9600 baud, bt 0.4, modulation index one half, on two 25 kHz
 * channels: A at 161.975 MHz and B at 162.025 MHz. Bits are nrzi coded (a
 * zero is a change of frequency) and wrapped in hdlc: 0x7e flags, a zero
 * stuffed after five ones, and an X.25 frame check. Bytes go out least
 * significant bit first.
 *
 * One IQ window centred between the channels carries both. Each channel is
 * mixed to zero, filtered, and decimated to about five samples a symbol.
 *
 * Two detectors then run side by side on every channel:
 *
 * - coherent. With index one half the carrier phase turns a quarter cycle
 *   each symbol, so rotating sample n back by n quarter turns leaves every
 *   symbol on one line through the origin, flipping sides whenever the
 *   frequency was high. The angle of that line is unknown, so the detector
 *   projects onto sixteen candidate angles and follows whichever keeps the
 *   largest average magnitude. A frequency error turns that line, so blocks of 512
 *   samples are first corrected using the squared signal, whose spectrum has
 *   two lines 9600 Hz apart centred on twice the error.
 * - fm. A discriminator, a centred mean to take out the carrier offset, and
 *   a sign. Weaker, but it holds on through a carrier that wanders inside a
 *   burst.
 *
 * A burst is at most about 256 bits, short enough that the 9600 baud clock
 * drifts by a few hundredths of a symbol across it, so instead of a clock
 * recovery loop each detector samples the stream at several fixed phases,
 * and whichever yields a frame with a good check wins. The same frame found
 * twice is reported once.
 */

import { ax25Fcs } from '../aprs'
import { Fft } from '@/core/dsp/fft'
import { ChannelFilter } from '@/core/dsp/channel'

export const AIS_BAUD = 9600
export const AIS_CHANNELS = [
  { id: 'A', hz: 161_975_000 },
  { id: 'B', hz: 162_025_000 },
] as const
export type AisChannelId = (typeof AIS_CHANNELS)[number]['id']

/** The spot between the two channels, where one window hears both. */
export const AIS_CENTER_HZ = 162_000_000

/** Half the band a channel needs: the gmsk main lobe plus room for drift. */
const CHANNEL_HALF_HZ = 11_000
/** Rate the first stage brings any input down to, at least. */
const STAGE1_MIN_RATE = 192_000
/** Rate the detectors run at, at least. */
const WORK_MIN_RATE = 48_000
/** Sampling phases tried per symbol. */
const PHASES = 5
/** Candidate angles for the coherent line, over half a turn. */
const ANGLES = 16
/** Symbols the coherent decision waits, so the angle choice sees what follows. */
const ANGLE_DELAY = 3
/** Weight of the past in the coherent angle average. */
const ANGLE_MEMORY = 0.85
/** Samples per frequency correction block. */
const AFC_BLOCK = 512
/** Largest carrier error the correction searches for. */
const AFC_MAX_HZ = 1200
/** Longest frame accepted: a five slot message is 1000 bits on air. */
const MAX_FRAME_BITS = 1100
/** The shortest messages, types 7 and 10, carry 72 bits, plus 16 of check. */
const MIN_FRAME_BITS = 88

export interface AisFrame {
  channel: AisChannelId
  /** The message, frame check removed. Fields read most significant bit first. */
  bytes: Uint8Array
  /** Where in the input the frame ended, counted in input samples. */
  atSample: number
  /** Level of the channel while the frame was in it, dB full scale. */
  levelDb: number
  /** Carrier offset the frequency correction measured, in Hz. */
  offsetHz: number
  /** Which detector found it first. */
  via: 'coherent' | 'fm'
}

/** Receives one frequency symbol at a time and finds checked hdlc frames. */
class Hdlc {
  private prev = 0
  private ones = 0
  private open = false
  private n = 0
  private readonly bits = new Uint8Array(MAX_FRAME_BITS)
  private readonly done: (bits: Uint8Array, n: number) => void

  constructor(done: (bits: Uint8Array, n: number) => void) {
    this.done = done
  }

  push(level: number): void {
    const sym = level > 0 ? 1 : 0
    const bit = sym === this.prev ? 1 : 0
    this.prev = sym
    if (bit) {
      this.ones++
      if (this.ones > 6) {
        this.open = false
        this.n = 0
        return
      }
      this.append(1)
      return
    }
    if (this.ones === 6) {
      // a flag: the zero and six ones already appended belong to it.
      if (this.open) {
        const len = this.n - 7
        if (len >= MIN_FRAME_BITS && len % 8 === 0) this.done(this.bits, len)
      }
      this.open = true
      this.n = 0
      this.ones = 0
      return
    }
    if (this.ones === 5) {
      this.ones = 0
      return
    }
    this.ones = 0
    this.append(0)
  }

  private append(bit: number): void {
    if (!this.open) return
    if (this.n >= MAX_FRAME_BITS) {
      this.open = false
      this.n = 0
      return
    }
    this.bits[this.n++] = bit
  }
}

/** A gaussian about a third of a symbol wide, the matched filter for the coherent path. */
function gaussianTaps(sps: number): Float32Array {
  const sigma = sps / 3
  const half = Math.ceil(sigma * 3)
  const taps = new Float32Array(half * 2 + 1)
  let sum = 0
  for (let i = -half; i <= half; i++) {
    taps[i + half] = Math.exp(-(i * i) / (2 * sigma * sigma))
    sum += taps[i + half]
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum
  return taps
}

/**
 * Finds the carrier error of a block from its square. Squaring msk folds its
 * two tones onto lines at twice the error plus and minus half the baud.
 */
class Afc {
  private readonly fft = new Fft(AFC_BLOCK)
  private readonly re = new Float32Array(AFC_BLOCK)
  private readonly im = new Float32Array(AFC_BLOCK)
  private readonly mag = new Float32Array(AFC_BLOCK)
  private readonly rate: number
  private readonly gap: number
  private readonly reach: number

  constructor(rate: number) {
    this.rate = rate
    this.gap = Math.round((AIS_BAUD / rate) * AFC_BLOCK)
    this.reach = Math.ceil(((2 * AFC_MAX_HZ) / rate) * AFC_BLOCK)
  }

  /** Error in cycles per sample. */
  estimate(bi: Float32Array, bq: Float32Array): number {
    const n = AFC_BLOCK
    for (let k = 0; k < n; k++) {
      const i = bi[k]
      const q = bq[k]
      this.re[k] = i * i - q * q
      this.im[k] = 2 * i * q
    }
    this.fft.transform(this.re, this.im)
    for (let k = 0; k < n; k++) this.mag[k] = Math.hypot(this.re[k], this.im[k])
    const half = this.gap / 2
    let best = -1
    let at = 0
    // the pair's centre is bin c: the low line at c - half, the high at c + half.
    for (let c = -this.reach; c <= this.reach; c++) {
      const lo = Math.round(c - half)
      const v = this.mag[(lo + n) % n] + this.mag[(lo + this.gap + n) % n]
      if (v > best) {
        best = v
        at = lo + half
      }
    }
    return at / n / 2
  }

  hz(cyclesPerSample: number): number {
    return cyclesPerSample * this.rate
  }
}

/** One sampling phase of the coherent detector. */
class CoherentPhase {
  private rot = 0
  private readonly ema = new Float32Array(ANGLES)
  private readonly hist = new Uint8Array(ANGLES)
  private best = 0
  readonly hdlc: Hdlc

  constructor(hdlc: Hdlc) {
    this.hdlc = hdlc
  }

  push(i: number, q: number): void {
    // turn the sample back by one quarter cycle per symbol.
    let re: number
    let im: number
    switch (this.rot) {
      case 0:
        re = i
        im = q
        break
      case 1:
        re = -q
        im = i
        break
      case 2:
        re = -i
        im = -q
        break
      default:
        re = q
        im = -i
    }
    this.rot = (this.rot + 1) & 3
    for (let m = 0; m < ANGLES; m++) {
      const t = re * COS[m] + im * SIN[m]
      this.hist[m] = ((this.hist[m] << 1) | (t > 0 ? 1 : 0)) & 0xff
      this.ema[m] = ANGLE_MEMORY * this.ema[m] + (1 - ANGLE_MEMORY) * Math.abs(t)
    }
    // the line turns slowly, so only the neighbours of the last choice compete.
    let pick = this.best
    let top = this.ema[pick]
    const left = (this.best + ANGLES - 1) % ANGLES
    const right = (this.best + 1) % ANGLES
    if (this.ema[left] > top) {
      pick = left
      top = this.ema[left]
    }
    if (this.ema[right] > top) pick = right
    this.best = pick
    const h = this.hist[pick]
    const flip = ((h >> ANGLE_DELAY) ^ (h >> (ANGLE_DELAY + 1))) & 1
    this.hdlc.push(flip ? 1 : -1)
  }
}

const COS = new Float32Array(ANGLES)
const SIN = new Float32Array(ANGLES)
for (let m = 0; m < ANGLES; m++) {
  COS[m] = Math.cos((Math.PI * m) / ANGLES)
  SIN[m] = Math.sin((Math.PI * m) / ANGLES)
}

class Channel {
  readonly id: AisChannelId
  private readonly filter: ChannelFilter
  private readonly afc: Afc
  private readonly sps: number
  private readonly toHz: number
  // afc block, corrected in place once full
  private readonly blockI = new Float32Array(AFC_BLOCK)
  private readonly blockQ = new Float32Array(AFC_BLOCK)
  private fill = 0
  private rotPhase = 0
  private offsetHz = 0
  // coherent path
  private readonly gauss: Float32Array
  private readonly gI: Float32Array
  private readonly gQ: Float32Array
  private gPos = 0
  private prevGI = 0
  private prevGQ = 0
  private readonly coherent: CoherentPhase[] = []
  private readonly dueC: Float64Array
  // fm path
  private lastI = 0
  private lastQ = 0
  private readonly smooth: Float32Array
  private smoothPos = 0
  private smoothSum = 0
  private readonly dcWin: Float32Array
  private dcPos = 0
  private dcSum = 0
  private readonly dcDelay: number
  private readonly fm: Hdlc[] = []
  private readonly dueF: Float64Array
  private prevY = 0

  private power = 0
  private readonly recent = new Map<string, number>()
  private workCount = 0
  private readonly emit: (f: AisFrame) => void
  private readonly clock: () => number

  constructor(id: AisChannelId, offsetHz: number, rate: number, emit: (f: AisFrame) => void, clock: () => number) {
    this.id = id
    this.emit = emit
    this.clock = clock
    this.filter = new ChannelFilter(offsetHz, rate, CHANNEL_HALF_HZ, WORK_MIN_RATE)
    const work = this.filter.outRate
    this.afc = new Afc(work)
    this.sps = work / AIS_BAUD
    this.toHz = work / (2 * Math.PI)

    this.gauss = gaussianTaps(this.sps)
    this.gI = new Float32Array(this.gauss.length * 2)
    this.gQ = new Float32Array(this.gauss.length * 2)

    this.smooth = new Float32Array(Math.max(1, Math.round(this.sps * 0.6)))
    const dcLen = Math.round(this.sps * 12)
    this.dcWin = new Float32Array(dcLen)
    this.dcDelay = Math.floor(dcLen / 2)

    this.dueC = new Float64Array(PHASES)
    this.dueF = new Float64Array(PHASES)
    for (let k = 0; k < PHASES; k++) {
      this.dueC[k] = (k * this.sps) / PHASES
      this.dueF[k] = (k * this.sps) / PHASES
      this.coherent.push(new CoherentPhase(new Hdlc((b, n) => this.frame(b, n, 'coherent'))))
      this.fm.push(new Hdlc((b, n) => this.frame(b, n, 'fm')))
    }
  }

  push(i: number, q: number): void {
    if (!this.filter.push(i, q)) return
    this.blockI[this.fill] = this.filter.outI
    this.blockQ[this.fill] = this.filter.outQ
    if (++this.fill < AFC_BLOCK) return
    this.fill = 0

    const f = this.afc.estimate(this.blockI, this.blockQ)
    this.offsetHz = this.afc.hz(f)
    const step = -2 * Math.PI * f
    for (let k = 0; k < AFC_BLOCK; k++) {
      this.rotPhase += step
      const c = Math.cos(this.rotPhase)
      const s = Math.sin(this.rotPhase)
      const bi = this.blockI[k]
      const bq = this.blockQ[k]
      this.work(bi * c - bq * s, bi * s + bq * c)
    }
    this.rotPhase %= 2 * Math.PI
  }

  private work(i: number, q: number): void {
    this.workCount++
    this.power = this.power * 0.995 + (i * i + q * q) * 0.005
    this.coherentStep(i, q)
    this.fmStep(i, q)
  }

  private coherentStep(i: number, q: number): void {
    const n = this.gauss.length
    this.gI[this.gPos] = i
    this.gI[this.gPos + n] = i
    this.gQ[this.gPos] = q
    this.gQ[this.gPos + n] = q
    this.gPos = this.gPos + 1 === n ? 0 : this.gPos + 1
    let fi = 0
    let fq = 0
    for (let k = 0, h = this.gPos; k < n; k++, h++) {
      fi += this.gauss[k] * this.gI[h]
      fq += this.gauss[k] * this.gQ[h]
    }
    for (let k = 0; k < PHASES; k++) {
      const at = this.dueC[k]
      if (at > 1) {
        this.dueC[k] = at - 1
        continue
      }
      this.coherent[k].push(this.prevGI + (fi - this.prevGI) * at, this.prevGQ + (fq - this.prevGQ) * at)
      this.dueC[k] = at - 1 + this.sps
    }
    this.prevGI = fi
    this.prevGQ = fq
  }

  private fmStep(i: number, q: number): void {
    const re = i * this.lastI + q * this.lastQ
    const im = q * this.lastI - i * this.lastQ
    this.lastI = i
    this.lastQ = q
    const f = Math.atan2(im, re) * this.toHz

    this.smoothSum += f - this.smooth[this.smoothPos]
    this.smooth[this.smoothPos] = f
    this.smoothPos = (this.smoothPos + 1) % this.smooth.length
    const s = this.smoothSum / this.smooth.length

    const dn = this.dcWin.length
    const delayed = this.dcWin[(this.dcPos + dn - this.dcDelay) % dn]
    this.dcSum += s - this.dcWin[this.dcPos]
    this.dcWin[this.dcPos] = s
    this.dcPos = (this.dcPos + 1) % dn
    const y = delayed - this.dcSum / dn

    for (let k = 0; k < PHASES; k++) {
      const at = this.dueF[k]
      if (at > 1) {
        this.dueF[k] = at - 1
        continue
      }
      // at lies in (0, 1]: between the previous sample and this one.
      this.fm[k].push(this.prevY + (y - this.prevY) * at)
      this.dueF[k] = at - 1 + this.sps
    }
    this.prevY = y
  }

  private frame(bits: Uint8Array, n: number, via: AisFrame['via']): void {
    const bytes = new Uint8Array(n / 8)
    for (let b = 0; b < n; b++) if (bits[b]) bytes[b >> 3] |= 1 << (b & 7)
    const len = bytes.length - 2
    const fcs = bytes[len] | (bytes[len + 1] << 8)
    if (ax25Fcs(bytes, len) !== fcs) return
    const msg = bytes.slice(0, len)

    let key = ''
    for (let k = 0; k < len; k++) key += String.fromCharCode(msg[k])
    // one burst seen on several phases and both detectors ends within a few symbols.
    const window = this.sps * 64
    const seen = this.recent.get(key)
    if (seen !== undefined && this.workCount - seen < window) return
    this.recent.set(key, this.workCount)
    if (this.recent.size > 64) {
      for (const [k, at] of this.recent) if (this.workCount - at > window) this.recent.delete(k)
    }

    this.emit({
      channel: this.id,
      bytes: msg,
      atSample: this.clock(),
      levelDb: 10 * Math.log10(this.power + 1e-20),
      offsetHz: this.offsetHz,
      via,
    })
  }
}

/**
 * Turns an IQ stream into AIS frames on whichever of the two channels the
 * window covers. Any sample rate and centre work, as long as a channel's
 * 22 kHz fits inside the window.
 */
export class AisReceiver {
  onFrame: ((f: AisFrame) => void) | null = null

  private rate = 0
  private center = 0
  private channels: Channel[] = []
  private d1 = 1
  private accI = 0
  private accQ = 0
  private accN = 0
  private consumed = 0

  /** Channels the current window holds. Empty when neither fits. */
  get listening(): AisChannelId[] {
    return this.channels.map((c) => c.id)
  }

  /** Input samples handled since the last reset. */
  get samples(): number {
    return this.consumed
  }

  reset(): void {
    this.rate = 0
    this.center = 0
    this.channels = []
    this.consumed = 0
  }

  /** Feeds interleaved I/Q floats. */
  feed(iq: Float32Array, centerHz: number, sampleRate: number): void {
    if (sampleRate !== this.rate || centerHz !== this.center) this.configure(centerHz, sampleRate)
    const chans = this.channels
    if (!chans.length) {
      this.consumed += iq.length / 2
      return
    }
    const d1 = this.d1
    const scale = 1 / d1
    for (let n = 0; n < iq.length; n += 2) {
      this.accI += iq[n]
      this.accQ += iq[n + 1]
      if (++this.accN < d1) continue
      const i = this.accI * scale
      const q = this.accQ * scale
      this.accI = 0
      this.accQ = 0
      this.accN = 0
      for (let c = 0; c < chans.length; c++) chans[c].push(i, q)
    }
    this.consumed += iq.length / 2
  }

  private configure(centerHz: number, sampleRate: number): void {
    this.rate = sampleRate
    this.center = centerHz
    this.d1 = Math.max(1, Math.floor(sampleRate / STAGE1_MIN_RATE))
    const r1 = sampleRate / this.d1
    this.accI = this.accQ = 0
    this.accN = 0
    this.channels = []
    for (const ch of AIS_CHANNELS) {
      const off = ch.hz - centerHz
      if (Math.abs(off) + CHANNEL_HALF_HZ > r1 / 2) continue
      this.channels.push(new Channel(ch.id, off, r1, (f) => this.onFrame?.(f), () => this.consumed))
    }
  }
}

/** Whether a window at this centre and rate holds a channel, and which. */
export function aisChannelsIn(centerHz: number, sampleRate: number): AisChannelId[] {
  const d1 = Math.max(1, Math.floor(sampleRate / STAGE1_MIN_RATE))
  const r1 = sampleRate / d1
  return AIS_CHANNELS.filter((ch) => Math.abs(ch.hz - centerHz) + CHANNEL_HALF_HZ <= r1 / 2).map((c) => c.id)
}

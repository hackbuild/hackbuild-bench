/**
 * QPSK and OQPSK demodulation for LRPT, from complex baseband to soft
 * symbol pairs.
 *
 * The chain is: mix the signal to zero and decimate to a few samples per
 * symbol, a root raised cosine matched filter, an agc, a carrier nco steered
 * by a Costas loop, and a Gardner timing loop picking samples off a cubic
 * interpolator. A fourth power spectrum finds the carrier first, since a
 * Costas loop narrow enough to track cleanly would take far too long to pull
 * in a Doppler shift of several kHz on its own.
 *
 * OQPSK delays Q by half a symbol. The I rail is read at the symbol strobe
 * and Q at the strobe half a symbol later, so each pair goes out once its Q
 * sample is in.
 */

export interface DemodOptions {
  symbolRate: number
  oqpsk: boolean
  /** Where the signal sits in the input, Hz from its centre. */
  offsetHz?: number
  /** Widest carrier error to search, Hz either side. */
  searchHz?: number
}

const RRC_ALPHA = 0.5
const RRC_SPAN = 5
/** Samples per symbol the first stage aims for after decimation. */
const TARGET_SPS = 3.2
const SOFT_SCALE = 48
const CONSTELLATION_POINTS = 512
const COARSE_FFT = 4096
const COARSE_AVERAGE = 4
/**
 * Loop bandwidths per symbol. Wider than these and the loops ride the noise
 * near threshold: at 4 dB Es/N0, 0.008 for the carrier lost half the frames
 * and 0.002 reached the textbook bit error rate. The coarse search does the
 * pull in, so narrow loops cost nothing at acquisition.
 */
const COSTAS_BW = 0.002
const TIMING_BW = 0.002

function rrcTaps(sps: number, alpha: number, span: number): Float32Array {
  const half = Math.ceil(span * sps)
  const taps = new Float32Array(2 * half + 1)
  let sum = 0
  for (let i = -half; i <= half; i++) {
    const t = i / sps
    let h: number
    if (Math.abs(t) < 1e-9) {
      h = 1 - alpha + (4 * alpha) / Math.PI
    } else if (Math.abs(Math.abs(4 * alpha * t) - 1) < 1e-9) {
      h =
        (alpha / Math.SQRT2) *
        ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * alpha)) +
          (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * alpha)))
    } else {
      h =
        (Math.sin(Math.PI * t * (1 - alpha)) + 4 * alpha * t * Math.cos(Math.PI * t * (1 + alpha))) /
        (Math.PI * t * (1 - (4 * alpha * t) ** 2))
    }
    taps[i + half] = h
    sum += h
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum
  return taps
}

function lowpassTaps(cutoff: number, n: number): Float32Array {
  const taps = new Float32Array(n)
  const m = (n - 1) / 2
  let sum = 0
  for (let i = 0; i < n; i++) {
    const x = i - m
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1))
    taps[i] = sinc * w
    sum += taps[i]
  }
  for (let i = 0; i < n; i++) taps[i] /= sum
  return taps
}

/** Second order loop gains for a normalized bandwidth and damping. */
function loopGains(bw: number, damping: number): [number, number] {
  const denom = 1 + 2 * damping * bw + bw * bw
  return [(4 * damping * bw) / denom, (4 * bw * bw) / denom]
}

/** Radix 2 complex FFT, in place. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

export interface DemodStats {
  /** Carrier offset the loop is tracking, Hz from where the signal was expected. */
  carrierHz: number
  /** 0 to 1, how square the constellation is. Above about 0.5 is a lock. */
  lock: number
  /** Symbol rate the timing loop has settled on. */
  symbolRate: number
  /** Last symbols, interleaved I and Q, scaled so a clean point sits near 1. */
  constellation: Float32Array
  symbols: number
}

export class LrptDemod {
  private readonly opts: Required<DemodOptions>
  private rate = 0
  private decim = 1
  private fs1 = 0
  private sps = 0

  // front end mixer and decimator
  private mixPhase = 0
  private mixStep = 0
  private lp: Float32Array = new Float32Array(1)
  private lpI: Float32Array = new Float32Array(0)
  private lpQ: Float32Array = new Float32Array(0)
  private lpPos = 0
  private decimCount = 0

  // matched filter
  private rrc: Float32Array = new Float32Array(1)
  private rrcI: Float32Array = new Float32Array(0)
  private rrcQ: Float32Array = new Float32Array(0)
  private rrcPos = 0

  // agc
  private power = 1

  // carrier
  private phase = 0
  private freq = 0
  private costasAlpha = 0
  private costasBeta = 0
  private lockAvg = 0

  // coarse carrier search over the fourth power
  private coarseRe = new Float64Array(COARSE_FFT)
  private coarseIm = new Float64Array(COARSE_FFT)
  private coarseAcc = new Float64Array(COARSE_FFT)
  private coarseFill = 0
  private coarseBlocks = 0

  // timing
  private histI = new Float32Array(8)
  private histQ = new Float32Array(8)
  /** Absolute index of the newest sample in the history. */
  private histN = -1
  private strobeAt = 0
  private halfPeriod = 0
  private halfNominal = 0
  private timingInteg = 0
  private kp = 0
  private ki = 0
  private onTime = true
  private prevSi = 0
  private prevSq = 0
  private midI = 0
  private midQ = 0
  private prevMidQ = 0
  private pendingI = 0
  private havePending = false

  // symbol scaling
  private amp = 1

  private constellation = new Float32Array(CONSTELLATION_POINTS * 2)
  private conPos = 0
  private symbols = 0
  private out: Int8Array = new Int8Array(0)
  private outN = 0

  constructor(opts: DemodOptions) {
    this.opts = {
      offsetHz: 0,
      searchHz: 12000,
      ...opts,
    }
  }

  get stats(): DemodStats {
    const symRate = this.halfPeriod > 0 ? this.fs1 / (2 * this.halfPeriod) : this.opts.symbolRate
    return {
      carrierHz: (this.freq * this.fs1) / (2 * Math.PI),
      lock: this.lockAvg,
      symbolRate: symRate,
      constellation: this.constellation,
      symbols: this.symbols,
    }
  }

  setOffset(hz: number): void {
    this.opts.offsetHz = hz
    if (this.rate) this.mixStep = (-2 * Math.PI * hz) / this.rate
  }

  reset(): void {
    this.rate = 0
  }

  private configure(rate: number): void {
    this.rate = rate
    const rs = this.opts.symbolRate
    this.decim = Math.max(1, Math.floor(rate / (TARGET_SPS * rs)))
    this.fs1 = rate / this.decim
    this.sps = this.fs1 / rs
    this.mixPhase = 0
    this.mixStep = (-2 * Math.PI * this.opts.offsetHz) / rate
    const n = this.decim > 1 ? 8 * this.decim + 1 : 1
    this.lp = this.decim > 1 ? lowpassTaps((0.85 * rs) / rate, n) : new Float32Array([1])
    this.lpI = new Float32Array(this.lp.length * 2)
    this.lpQ = new Float32Array(this.lp.length * 2)
    this.lpPos = 0
    this.decimCount = 0
    this.rrc = rrcTaps(this.sps, RRC_ALPHA, RRC_SPAN)
    this.rrcI = new Float32Array(this.rrc.length * 2)
    this.rrcQ = new Float32Array(this.rrc.length * 2)
    this.rrcPos = 0
    this.power = 1
    this.phase = 0
    this.freq = 0
    ;[this.costasAlpha, this.costasBeta] = loopGains(COSTAS_BW, 0.707)
    this.lockAvg = 0
    this.coarseFill = 0
    this.coarseBlocks = 0
    this.coarseAcc.fill(0)
    this.histI.fill(0)
    this.histQ.fill(0)
    this.histN = -1
    this.halfNominal = this.sps / 2
    this.halfPeriod = this.halfNominal
    this.strobeAt = 4
    this.timingInteg = 0
    const [a, b] = loopGains(TIMING_BW, 1)
    this.kp = a * this.sps
    this.ki = b * this.sps
    this.onTime = true
    this.havePending = false
    this.amp = 1
  }

  /** Demodulates interleaved float IQ. Returns soft pairs, I then Q. */
  process(iq: Float32Array, rate: number): Int8Array {
    if (rate !== this.rate) this.configure(rate)
    const maxSyms = Math.ceil(iq.length / 2 / this.sps) + 4
    if (this.out.length < maxSyms * 2) this.out = new Int8Array(maxSyms * 2 + 64)
    this.outN = 0

    const lp = this.lp
    const lpLen = lp.length
    const lpI = this.lpI
    const lpQ = this.lpQ
    let lpPos = this.lpPos
    let decimCount = this.decimCount
    let mixPhase = this.mixPhase
    const mixStep = this.mixStep
    let cr = Math.cos(mixPhase)
    let ci = Math.sin(mixPhase)
    const sr = Math.cos(mixStep)
    const si = Math.sin(mixStep)

    for (let k = 0; k < iq.length; k += 2) {
      const x = iq[k]
      const y = iq[k + 1]
      const mi = x * cr - y * ci
      const mq = x * ci + y * cr
      const ncr = cr * sr - ci * si
      ci = cr * si + ci * sr
      cr = ncr

      lpI[lpPos] = lpI[lpPos + lpLen] = mi
      lpQ[lpPos] = lpQ[lpPos + lpLen] = mq
      lpPos = lpPos + 1 === lpLen ? 0 : lpPos + 1
      if (++decimCount < this.decim) continue
      decimCount = 0
      let fi = 0
      let fq = 0
      for (let t = 0; t < lpLen; t++) {
        fi += lp[t] * lpI[lpPos + t]
        fq += lp[t] * lpQ[lpPos + t]
      }
      this.sample(fi, fq)
    }
    // the recurrence drifts in magnitude, so the phase restarts from the angle.
    mixPhase = (mixPhase + (mixStep * iq.length) / 2) % (2 * Math.PI)
    this.mixPhase = mixPhase
    this.lpPos = lpPos
    this.decimCount = decimCount
    return this.out.subarray(0, this.outN)
  }

  /** One sample at the decimated rate. */
  private sample(xi: number, xq: number): void {
    const rrc = this.rrc
    const n = rrc.length
    const pos = this.rrcPos
    this.rrcI[pos] = this.rrcI[pos + n] = xi
    this.rrcQ[pos] = this.rrcQ[pos + n] = xq
    this.rrcPos = pos + 1 === n ? 0 : pos + 1
    let fi = 0
    let fq = 0
    const base = this.rrcPos
    for (let t = 0; t < n; t++) {
      fi += rrc[t] * this.rrcI[base + t]
      fq += rrc[t] * this.rrcQ[base + t]
    }

    const p = fi * fi + fq * fq
    this.power += (p - this.power) * 0.0005
    const g = 1 / Math.sqrt(this.power + 1e-20)
    fi *= g
    fq *= g

    this.coarse(fi, fq)

    const c = Math.cos(this.phase)
    const s = Math.sin(this.phase)
    const yi = fi * c + fq * s
    const yq = fq * c - fi * s
    this.phase += this.freq
    if (this.phase > Math.PI) this.phase -= 2 * Math.PI
    else if (this.phase < -Math.PI) this.phase += 2 * Math.PI

    const h = ++this.histN & 7
    this.histI[h] = yi
    this.histQ[h] = yq

    // a strobe needs two samples after it for the cubic.
    while (this.strobeAt <= this.histN - 2) {
      const t = this.strobeAt
      const base = Math.floor(t)
      const mu = t - base
      const [ii, qq] = this.interp(base, mu)
      this.strobe(ii, qq)
      this.strobeAt += this.halfPeriod
    }
  }

  private interp(base: number, mu: number): [number, number] {
    const hi = this.histI
    const hq = this.histQ
    const i0 = (base - 1) & 7
    const i1 = base & 7
    const i2 = (base + 1) & 7
    const i3 = (base + 2) & 7
    const m2 = mu * mu
    const m3 = m2 * mu
    const c0 = (-m3 + 3 * m2 - 2 * mu) / 6
    const c1 = (m3 - 2 * m2 - mu + 2) / 2
    const c2 = (-m3 + m2 + 2 * mu) / 2
    const c3 = (m3 - mu) / 6
    return [
      c0 * hi[i0] + c1 * hi[i1] + c2 * hi[i2] + c3 * hi[i3],
      c0 * hq[i0] + c1 * hq[i1] + c2 * hq[i2] + c3 * hq[i3],
    ]
  }

  private strobe(si: number, sq: number): void {
    const onTime = this.onTime
    this.onTime = !onTime
    if (!this.opts.oqpsk) {
      if (!onTime) {
        this.midI = si
        this.midQ = sq
        return
      }
      const err = this.midI * (this.prevSi - si) + this.midQ * (this.prevSq - sq)
      this.prevSi = si
      this.prevSq = sq
      this.timing(err)
      this.symbol(si, sq)
      return
    }
    if (onTime) {
      // the I rail's symbol, and the Q rail's crossing.
      const errI = this.midI * (this.prevSi - si)
      this.timing(errI * 0.5)
      this.prevSi = si
      this.pendingI = si
      this.havePending = true
      this.midQ = sq
      return
    }
    // the Q rail's symbol, and the I rail's crossing.
    const errQ = this.midQ * (this.prevMidQ - sq)
    this.timing(errQ * 0.5)
    this.prevMidQ = sq
    this.midI = si
    if (this.havePending) {
      this.havePending = false
      this.symbol(this.pendingI, sq)
    }
  }

  private timing(err: number): void {
    const e = Math.max(-1, Math.min(1, err))
    this.timingInteg += this.ki * e
    const lim = this.halfNominal * 0.005
    if (this.timingInteg > lim) this.timingInteg = lim
    else if (this.timingInteg < -lim) this.timingInteg = -lim
    this.halfPeriod = this.halfNominal + this.timingInteg
    this.strobeAt += this.kp * e
  }

  private symbol(i: number, q: number): void {
    // carrier error for QPSK with decisions, normalized so it reads in radians.
    const err = (Math.sign(i) * q - Math.sign(q) * i) / (Math.abs(i) + Math.abs(q) + 1e-9)
    this.phase += this.costasAlpha * err
    this.freq += (this.costasBeta * err) / this.sps

    const r2 = i * i + q * q + 1e-12
    const re4 = (i * i - q * q) ** 2 - 4 * i * i * q * q
    this.lockAvg += (-re4 / (r2 * r2) - this.lockAvg) * 0.002

    const a = (Math.abs(i) + Math.abs(q)) / 2
    this.amp += (a - this.amp) * 0.002
    const scale = SOFT_SCALE / (this.amp + 1e-9)
    let vi = Math.round(i * scale)
    let vq = Math.round(q * scale)
    vi = vi > 127 ? 127 : vi < -127 ? -127 : vi
    vq = vq > 127 ? 127 : vq < -127 ? -127 : vq
    this.out[this.outN++] = vi
    this.out[this.outN++] = vq

    const cp = this.conPos
    this.constellation[cp] = i / (this.amp + 1e-9)
    this.constellation[cp + 1] = q / (this.amp + 1e-9)
    this.conPos = (cp + 2) % this.constellation.length
    this.symbols++
  }

  /** Accumulates fourth power spectra and retunes the nco while unlocked. */
  private coarse(i: number, q: number): void {
    const i2 = i * i - q * q
    const q2 = 2 * i * q
    const k = this.coarseFill++
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / COARSE_FFT)
    this.coarseRe[k] = (i2 * i2 - q2 * q2) * w
    this.coarseIm[k] = 2 * i2 * q2 * w
    if (this.coarseFill < COARSE_FFT) return
    this.coarseFill = 0
    fft(this.coarseRe, this.coarseIm)
    for (let b = 0; b < COARSE_FFT; b++) {
      this.coarseAcc[b] += this.coarseRe[b] ** 2 + this.coarseIm[b] ** 2
    }
    if (++this.coarseBlocks < COARSE_AVERAGE) return
    this.coarseBlocks = 0

    const acc = this.coarseAcc
    const limit = Math.min(COARSE_FFT / 2 - 2, Math.floor((4 * this.opts.searchHz * COARSE_FFT) / this.fs1))
    let best = 0
    let bestV = -1
    let total = 0
    let count = 0
    for (let d = -limit; d <= limit; d++) {
      const b = (d + COARSE_FFT) % COARSE_FFT
      total += acc[b]
      count++
      if (acc[b] > bestV) {
        bestV = acc[b]
        best = d
      }
    }
    const mean = total / Math.max(1, count)
    const bm = acc[(best - 1 + COARSE_FFT) % COARSE_FFT]
    const bp = acc[(best + 1 + COARSE_FFT) % COARSE_FFT]
    const den = bm - 2 * bestV + bp
    const frac = den !== 0 ? (0.5 * (bm - bp)) / den : 0
    acc.fill(0)

    // only a clear line moves a loop that has not locked.
    if (bestV < 8 * mean || this.lockAvg > 0.4) return
    const hz = ((best + frac) * this.fs1) / COARSE_FFT / 4
    this.freq = (2 * Math.PI * hz) / this.fs1
  }
}

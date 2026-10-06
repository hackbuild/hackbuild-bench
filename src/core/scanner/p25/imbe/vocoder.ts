/**
 * The IMBE 7200x4400 vocoder P25 phase 1 voice uses: error correction of a
 * 144 bit frame down to 88 bits of parameters, the parameters back to a
 * pitch, voicing and spectral amplitudes, and those to 20 ms of speech at
 * 8 kHz.
 *
 * A port of mbelib's imbe7200x4400.c, ecc.c and mbelib.c, which follow
 * TIA-102.BABA. The IMBE patents have expired.
 *
 * mbelib: Copyright (C) 2010 mbelib Author. Permission to use, copy, modify,
 * and/or distribute this software for any purpose with or without fee is
 * hereby granted, provided that the above copyright notice and this
 * permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS"
 * AND ISC DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE.
 */

import {
  B2,
  ImbeJi,
  Ws,
  ba,
  bo,
  golayGenerator,
  golayMatrix,
  hammingGenerator,
  hammingMatrix,
  hoba,
  quantstep,
  standdev,
} from './tables'

/** Samples a frame makes, 20 ms at 8 kHz. */
export const FRAME_SAMPLES = 160
export const AUDIO_RATE = 8000
const N = FRAME_SAMPLES
/** Unvoiced bands are a mix of this many sines, mbelib's default. */
const UV_QUALITY = 3

export interface MbeParms {
  w0: number
  L: number
  K: number
  Vl: Int32Array
  Ml: Float32Array
  log2Ml: Float32Array
  PHIl: Float32Array
  PSIl: Float32Array
  gamma: number
  repeat: number
}

/**
 * Harmonics run 1 to 56. The amplitude prediction reads one past the last
 * harmonic of the previous frame, always weighted by zero. In mbelib that
 * read lands on the next field of the struct, which is zero, so the arrays
 * here carry a zero past the end rather than read undefined.
 */
const HARMONICS = 58

function newParms(): MbeParms {
  return {
    w0: 0,
    L: 0,
    K: 0,
    Vl: new Int32Array(HARMONICS),
    Ml: new Float32Array(HARMONICS),
    log2Ml: new Float32Array(HARMONICS),
    PHIl: new Float32Array(HARMONICS),
    PSIl: new Float32Array(HARMONICS),
    gamma: 0,
    repeat: 0,
  }
}

/** A 144 bit frame as mbelib holds it: eight rows of up to 23 bits. */
export type ImbeFrame = Int8Array

export function newFrame(): ImbeFrame {
  return new Int8Array(8 * 23)
}

const at = (r: number, c: number) => r * 23 + c

function golay2312(fr: ImbeFrame, row: number, out: Int8Array): number {
  let block = 0
  for (let i = 22; i >= 0; i--) block = block * 2 + fr[at(row, i)]
  let mask = 0x400000
  let expected = 0
  for (let i = 0; i < 12; i++) {
    if (block & mask) expected ^= golayGenerator[i]
    mask >>= 1
  }
  const syndrome = expected ^ (block & 0x7ff)
  let data = (block >> 11) ^ golayMatrix[syndrome]
  for (let i = 22; i >= 11; i--) {
    out[i] = (data & 2048) >> 11
    data <<= 1
  }
  for (let i = 10; i >= 0; i--) out[i] = fr[at(row, i)]
  let errs = 0
  for (let i = 22; i >= 11; i--) if (out[i] !== fr[at(row, i)]) errs++
  return errs
}

function hamming1511(fr: ImbeFrame, row: number, out: Int8Array): number {
  let block = 0
  for (let i = 14; i >= 0; i--) block = (block << 1) | fr[at(row, i)]
  let syndrome = 0
  for (let i = 0; i < 4; i++) {
    syndrome <<= 1
    let v = block & hammingGenerator[i]
    let parity = v % 2
    for (let j = 0; j < 14; j++) {
      v >>= 1
      parity ^= v % 2
    }
    syndrome |= parity
  }
  let errs = 0
  if (syndrome > 0) {
    errs++
    block ^= hammingMatrix[syndrome]
  }
  for (let i = 14; i >= 0; i--) {
    out[i] = (block & 0x4000) >> 14
    block <<= 1
  }
  return errs
}

/** Corrects the first Golay word in place, since it seeds the descrambler. */
function eccC0(fr: ImbeFrame): number {
  const out = new Int8Array(23)
  const errs = golay2312(fr, 0, out)
  for (let j = 0; j < 23; j++) fr[at(0, j)] = out[j]
  return errs
}

/** Undoes the scrambling of rows 1 to 6, seeded from the first word's data. */
function demodulate(fr: ImbeFrame): void {
  let seed = 0
  for (let i = 22; i >= 11; i--) seed = seed * 2 + fr[at(0, i)]
  const pr = new Uint16Array(115)
  pr[0] = 16 * seed
  for (let i = 1; i < 115; i++) pr[i] = (173 * pr[i - 1] + 13849) % 65536
  for (let i = 1; i < 115; i++) pr[i] = pr[i] >> 15
  let k = 1
  for (let i = 1; i < 4; i++) for (let j = 22; j >= 0; j--) fr[at(i, j)] ^= pr[k++]
  for (let i = 4; i < 7; i++) for (let j = 14; j >= 0; j--) fr[at(i, j)] ^= pr[k++]
}

/** Corrects the rest of the frame and gathers the 88 parameter bits. */
function eccData(fr: ImbeFrame, d: Int8Array): number {
  let errs = 0
  let p = 0
  const g = new Int8Array(23)
  const h = new Int8Array(15)
  for (let i = 0; i < 4; i++) {
    if (i > 0) {
      errs += golay2312(fr, i, g)
      for (let j = 22; j > 10; j--) d[p++] = g[j]
    } else {
      for (let j = 22; j > 10; j--) d[p++] = fr[at(i, j)]
    }
  }
  for (let i = 4; i < 7; i++) {
    errs += hamming1511(fr, i, h)
    for (let j = 14; j >= 4; j--) d[p++] = h[j]
  }
  for (let j = 6; j >= 0; j--) d[p++] = fr[at(7, j)]
  return errs
}

/** Reads bits most significant first into a number. */
function bitsOf(get: (i: number) => number, count: number): number {
  let v = 0
  for (let i = 0; i < count; i++) v = v * 2 + get(i)
  return v
}

/** The 88 parameter bits to pitch, voicing and spectral amplitudes. False for a frame that carries none. */
function decodeParms(d: Int8Array, cur: MbeParms, prev: MbeParms): boolean {
  cur.repeat = prev.repeat
  const b0 = bitsOf((i) => (i < 6 ? d[i] : d[85 + i - 6]), 8)
  if (b0 > 207) return false

  cur.w0 = (4 * Math.PI) / (b0 + 39.5)
  const L = Math.trunc(0.9254 * Math.trunc(Math.PI / cur.w0 + 0.25))
  if (L > 56 || L < 9) return false
  cur.L = L
  const L9 = L - 9
  const K = L < 37 ? Math.trunc((L + 2) / 3) : 12
  cur.K = K

  const bb: Int8Array[] = Array.from({ length: 58 }, () => new Int8Array(12))
  for (let i = 6; i < 85; i++) {
    const o = (L9 * 79 + (i - 6)) * 2
    bb[bo[o]][bo[o + 1]] = d[i]
  }

  let j = 1
  let k = K - 1
  for (let i = 1; i <= L; i++) {
    cur.Vl[i] = bb[1][k]
    if (j === 3) {
      j = 1
      if (k > 0) k--
    } else j++
  }

  const Gm = new Float64Array(7)
  Gm[1] = B2[bitsOf((i) => bb[2][5 - i], 6)]
  for (let i = 2; i < 7; i++) {
    const o = (L9 * 5 + (i - 2)) * 2
    const bits = ba[o]
    const step = ba[o + 1]
    const bm = bitsOf((x) => bb[i + 1][bits - 1 - x], bits)
    Gm[i] = step * (bm - 2 ** (bits - 1) + 0.5)
  }

  const Ri = new Float64Array(7)
  for (let i = 1; i <= 6; i++) {
    let sum = 0
    for (let m = 1; m <= 6; m++) {
      const am = m === 1 ? 1 : 2
      sum += am * Gm[m] * Math.cos((Math.PI * (m - 1) * (i - 0.5)) / 6)
    }
    Ri[i] = sum
  }

  const Cik: Float64Array[] = Array.from({ length: 7 }, () => new Float64Array(11))
  let m = 8
  for (let i = 1; i <= 6; i++) {
    Cik[i][1] = Ri[i]
    for (let kk = 2; kk <= ImbeJi[L9 * 6 + i - 1]; kk++) {
      const Bm = hoba[L9 * 50 + m - 8]
      if (Bm === 0) Cik[i][kk] = 0
      else {
        const bm = bitsOf((x) => bb[m][Bm - 1 - x], Bm)
        Cik[i][kk] = quantstep[Bm - 1] * standdev[kk - 2] * (bm - 2 ** (Bm - 1) + 0.5)
      }
      m++
    }
  }

  const Tl = new Float64Array(57)
  let l = 1
  for (let i = 1; i <= 6; i++) {
    const ji = ImbeJi[L9 * 6 + i - 1]
    for (let jj = 1; jj <= ji; jj++) {
      let sum = 0
      for (let kk = 1; kk <= ji; kk++) {
        const ak = kk === 1 ? 1 : 2
        sum += ak * Cik[i][kk] * Math.cos((Math.PI * (kk - 1) * (jj - 0.5)) / ji)
      }
      Tl[l++] = sum
    }
  }

  const rho = cur.L <= 15 ? 0.4 : cur.L <= 24 ? 0.03 * cur.L - 0.05 : 0.7
  if (cur.L > prev.L) {
    for (let ll = prev.L + 1; ll <= cur.L; ll++) {
      prev.Ml[ll] = prev.Ml[prev.L]
      prev.log2Ml[ll] = prev.log2Ml[prev.L]
    }
  }

  const intkl = new Int32Array(57)
  const deltal = new Float64Array(57)
  let sum77 = 0
  for (let ll = 1; ll <= cur.L; ll++) {
    const flokl = (prev.L / cur.L) * ll
    intkl[ll] = Math.trunc(flokl)
    deltal[ll] = flokl - intkl[ll]
    sum77 += (1 - deltal[ll]) * prev.log2Ml[intkl[ll]] + deltal[ll] * prev.log2Ml[intkl[ll] + 1]
  }
  sum77 = (rho / cur.L) * sum77

  for (let ll = 1; ll <= cur.L; ll++) {
    const c1 = rho * (1 - deltal[ll]) * prev.log2Ml[intkl[ll]]
    const c2 = rho * deltal[ll] * prev.log2Ml[intkl[ll] + 1]
    cur.log2Ml[ll] = Tl[ll] + c1 + c2 - sum77
    cur.Ml[ll] = 2 ** cur.log2Ml[ll]
  }
  return true
}

function move(from: MbeParms, to: MbeParms): void {
  to.w0 = from.w0
  to.L = from.L
  to.K = from.K
  to.gamma = from.gamma
  to.repeat = from.repeat
  to.Ml.set(from.Ml)
  to.Vl.set(from.Vl)
  to.log2Ml.set(from.log2Ml)
  to.PHIl.set(from.PHIl)
  to.PSIl.set(from.PSIl)
}

function spectralAmpEnhance(cur: MbeParms): void {
  let Rm0 = 0
  let Rm1 = 0
  for (let l = 1; l <= cur.L; l++) {
    Rm0 += cur.Ml[l] * cur.Ml[l]
    Rm1 += cur.Ml[l] * cur.Ml[l] * Math.cos(cur.w0 * l)
  }
  const R2m0 = Rm0 * Rm0
  const R2m1 = Rm1 * Rm1
  for (let l = 1; l <= cur.L; l++) {
    if (cur.Ml[l] === 0) continue
    const Wl =
      Math.sqrt(cur.Ml[l]) *
      ((0.96 * Math.PI * (R2m0 + R2m1 - 2 * Rm0 * Rm1 * Math.cos(cur.w0 * l))) / (cur.w0 * Rm0 * (R2m0 - R2m1))) ** 0.25
    if (8 * l <= cur.L) continue
    if (Wl > 1.2) cur.Ml[l] = 1.2 * cur.Ml[l]
    else if (Wl < 0.5) cur.Ml[l] = 0.5 * cur.Ml[l]
    else cur.Ml[l] = Wl * cur.Ml[l]
  }
  let sum = 0
  for (let l = 1; l <= cur.L; l++) sum += cur.Ml[l] * cur.Ml[l]
  const gamma = sum === 0 ? 1 : Math.sqrt(Rm0 / sum)
  for (let l = 1; l <= cur.L; l++) cur.Ml[l] = gamma * cur.Ml[l]
}

function synthesize(out: Float32Array, cur: MbeParms, prev: MbeParms, rand: () => number): void {
  const randPhase = () => rand() * Math.PI * 2 - Math.PI
  const uvThreshold = (2700 * Math.PI) / 4000
  const uvSine = 1.3591409 * Math.E
  const uvRand = 2
  const uvq = UV_QUALITY
  const qfactor = Math.log(uvq) / uvq
  const uvStep = 1 / uvq
  const uvOffset = (uvStep * (uvq - 1)) / 2

  let numUv = 0
  for (let l = 1; l <= cur.L; l++) if (cur.Vl[l] === 0) numUv++
  const cw0 = cur.w0
  const pw0 = prev.w0
  out.fill(0)

  let maxl: number
  if (cur.L > prev.L) {
    maxl = cur.L
    for (let l = prev.L + 1; l <= maxl; l++) {
      prev.Ml[l] = 0
      prev.Vl[l] = 1
    }
  } else {
    maxl = prev.L
    for (let l = cur.L + 1; l <= maxl; l++) {
      cur.Ml[l] = 0
      cur.Vl[l] = 1
    }
  }

  for (let l = 1; l <= 56; l++) {
    cur.PSIl[l] = prev.PSIl[l] + (pw0 + cw0) * ((l * N) / 2)
    cur.PHIl[l] = l <= Math.trunc(cur.L / 4) ? cur.PSIl[l] : cur.PSIl[l] + (numUv * randPhase()) / cur.L
  }

  const rphase = new Float64Array(uvq)
  const rphase2 = new Float64Array(uvq)
  // the sum of sines an unvoiced band is drawn as, for a pitch and a band.
  const unvoiced = (w0: number, l: number, n: number, phases: Float64Array): number => {
    let c = 0
    const w0l = w0 * l
    for (let i = 0; i < uvq; i++) {
      c += Math.cos(w0 * n * (l + i * uvStep - uvOffset) + phases[i])
      if (w0l > uvThreshold) c += (w0l - uvThreshold) * uvRand * rand()
    }
    return c
  }

  for (let l = 1; l <= maxl; l++) {
    const cw0l = cw0 * l
    const pw0l = pw0 * l
    if (cur.Vl[l] === 0 && prev.Vl[l] === 1) {
      for (let i = 0; i < uvq; i++) rphase[i] = randPhase()
      for (let n = 0; n < N; n++) {
        const c1 = Ws[n + N] * prev.Ml[l] * Math.cos(pw0l * n + prev.PHIl[l])
        const c3 = unvoiced(cw0, l, n, rphase) * uvSine * Ws[n] * cur.Ml[l] * qfactor
        out[n] += c1 + c3
      }
    } else if (cur.Vl[l] === 1 && prev.Vl[l] === 0) {
      for (let i = 0; i < uvq; i++) rphase[i] = randPhase()
      for (let n = 0; n < N; n++) {
        const c1 = Ws[n] * cur.Ml[l] * Math.cos(cw0l * (n - N) + cur.PHIl[l])
        const c3 = unvoiced(pw0, l, n, rphase) * uvSine * Ws[n + N] * prev.Ml[l] * qfactor
        out[n] += c1 + c3
      }
    } else if (cur.Vl[l] === 1 || prev.Vl[l] === 1) {
      for (let n = 0; n < N; n++) {
        const c1 = Ws[n + N] * prev.Ml[l] * Math.cos(pw0l * n + prev.PHIl[l])
        const c2 = Ws[n] * cur.Ml[l] * Math.cos(cw0l * (n - N) + cur.PHIl[l])
        out[n] += c1 + c2
      }
    } else {
      for (let i = 0; i < uvq; i++) rphase[i] = randPhase()
      for (let i = 0; i < uvq; i++) rphase2[i] = randPhase()
      for (let n = 0; n < N; n++) {
        const c3 = unvoiced(pw0, l, n, rphase) * uvSine * Ws[n + N] * prev.Ml[l] * qfactor
        const c4 = unvoiced(cw0, l, n, rphase2) * uvSine * Ws[n] * cur.Ml[l] * qfactor
        out[n] += c3 + c4
      }
    }
  }
}

function softLimit(x: number): number {
  const a = Math.abs(x)
  if (a <= 0.8) return x
  return Math.sign(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2))
}

export interface ImbeResult {
  /** 160 samples at 8 kHz, about -1 to 1. */
  audio: Float32Array
  /** Bits the first Golay word corrected. */
  errs: number
  /** Bits corrected across the whole frame. */
  errs2: number
  /** The frame was replaced by the last good one, or by silence. */
  repeated: boolean
}

/** One talker's stream of IMBE frames. The parameters carry from frame to frame. */
export class ImbeDecoder {
  readonly cur = newParms()
  readonly prev = newParms()
  readonly prevEnhanced = newParms()
  /** The 88 parameter bits of the last frame, for tests. */
  readonly data = new Int8Array(88)

  constructor(private readonly rand: () => number = Math.random) {
    this.reset()
  }

  /** mbe_initMbeParms: a quiet start, as at the head of a call. */
  reset(): void {
    const p = this.prev
    p.w0 = 0.09378
    p.L = 30
    p.K = 10
    p.gamma = 0
    p.Ml.fill(0)
    p.Vl.fill(0)
    p.log2Ml.fill(0)
    p.PHIl.fill(0)
    p.PSIl.fill(Math.PI / 2)
    p.log2Ml[HARMONICS - 1] = 0
    p.repeat = 0
    move(p, this.cur)
    move(p, this.prevEnhanced)
  }

  /** One 144 bit frame in, 20 ms of audio out. The frame is corrected in place. */
  decode(frame: ImbeFrame): ImbeResult {
    const audio = new Float32Array(N)
    const errs = eccC0(frame)
    demodulate(frame)
    const errs2 = errs + eccData(frame, this.data)
    const ok = decodeParms(this.data, this.cur, this.prev)
    let repeated = false
    if (!ok || errs2 > 5) {
      move(this.prev, this.cur)
      this.cur.repeat++
      repeated = true
    } else this.cur.repeat = 0
    if (this.cur.repeat <= 3) {
      move(this.cur, this.prev)
      spectralAmpEnhance(this.cur)
      synthesize(audio, this.cur, this.prevEnhanced, this.rand)
      move(this.cur, this.prevEnhanced)
      // mbelib scales by 7 into 16 bit samples. the rare peak past full scale
      // is rounded off rather than cut.
      for (let n = 0; n < N; n++) audio[n] = softLimit((audio[n] * 7) / 32768)
    } else {
      this.reset()
    }
    return { audio, errs, errs2, repeated }
  }
}

/**
 * A synthetic Meteor M2-x LRPT transmitter for demo mode.
 *
 * It draws a made-up three channel scene, compresses it the way MSU-MR
 * does, packs it into packets, VCDUs and CADUs with Reed-Solomon parity,
 * randomizes, NRZ-M codes, convolutionally codes, and shapes OQPSK with a
 * root raised cosine, then adds a drifting carrier offset and noise. The
 * result goes through the same decoder a real pass does, so the demo is a
 * test of the whole chain.
 */

import { ASM, CADU_BYTES, PN, RS_N, rsEncodeCadu } from './ccsds'
import { convEncode } from './viterbi'
import { AC_TABLE, DC_TABLE, MCU_PER_PACKET, MSUMR_WIDTH, STRIP_WIDTH, ZIGZAG, quantTable } from './msumr'
import { MPDU_ZONE } from './packets'

const SYMBOL_RATE = 72000
const RRC_ALPHA = 0.5
const RRC_SPAN = 4
const TABLE_RES = 64
const QUALITY = 80
const SCID = 57
const APIDS = [64, 65, 66]

class BitWriter {
  bytes: number[] = []
  private cur = 0
  private n = 0

  put(value: number, len: number): void {
    for (let i = len - 1; i >= 0; i--) {
      this.cur = (this.cur << 1) | ((value >> i) & 1)
      if (++this.n === 8) {
        this.bytes.push(this.cur)
        this.cur = 0
        this.n = 0
      }
    }
  }

  finish(): Uint8Array {
    while (this.n !== 0) this.put(1, 1)
    return new Uint8Array(this.bytes)
  }
}

function category(v: number): number {
  let a = Math.abs(v)
  let n = 0
  while (a) {
    n++
    a >>= 1
  }
  return n
}

function putValue(w: BitWriter, v: number, size: number): void {
  if (size) w.put(v < 0 ? v + (1 << size) - 1 : v, size)
}

const FCOS = (() => {
  const t = new Float64Array(64)
  for (let u = 0; u < 8; u++) {
    for (let x = 0; x < 8; x++) {
      t[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16) / 2
    }
  }
  return t
})()

/** Compresses 14 blocks of an 8 row strip into one packet's Huffman data. */
function encodeStrip(pixels: Uint8Array, q: Int32Array): Uint8Array {
  const w = new BitWriter()
  const tmp = new Float64Array(64)
  const coef = new Float64Array(64)
  let prevDc = 0
  for (let m = 0; m < MCU_PER_PACKET; m++) {
    for (let y = 0; y < 8; y++) {
      for (let u = 0; u < 8; u++) {
        let s = 0
        for (let x = 0; x < 8; x++) s += FCOS[u * 8 + x] * (pixels[y * STRIP_WIDTH + m * 8 + x] - 128)
        tmp[y * 8 + u] = s
      }
    }
    for (let u = 0; u < 8; u++) {
      for (let v = 0; v < 8; v++) {
        let s = 0
        for (let y = 0; y < 8; y++) s += FCOS[v * 8 + y] * tmp[y * 8 + u]
        coef[v * 8 + u] = s
      }
    }
    const zz = new Int32Array(64)
    for (let i = 0; i < 64; i++) zz[i] = Math.round(coef[ZIGZAG[i]] / q[ZIGZAG[i]])
    const diff = zz[0] - prevDc
    prevDc = zz[0]
    const dcCat = category(diff)
    const dc = DC_TABLE.code.get(dcCat)
    if (!dc) throw new Error('dc out of range')
    w.put(dc[0], dc[1])
    putValue(w, diff, dcCat)
    let run = 0
    for (let k = 1; k < 64; k++) {
      if (zz[k] === 0) {
        run++
        continue
      }
      while (run > 15) {
        const zrl = AC_TABLE.code.get(0xf0)!
        w.put(zrl[0], zrl[1])
        run -= 16
      }
      const size = Math.min(10, category(zz[k]))
      const v = Math.max(-(1 << size) + 1, Math.min((1 << size) - 1, zz[k]))
      const c = AC_TABLE.code.get((run << 4) | size)!
      w.put(c[0], c[1])
      putValue(w, v, size)
      run = 0
    }
    if (run > 0) {
      const eob = AC_TABLE.code.get(0x00)!
      w.put(eob[0], eob[1])
    }
  }
  return w.finish()
}

/**
 * A smooth made-up scene, land, sea and cloud, so the composite reads like
 * a daytime pass: clouds bright in every channel, land brighter in the
 * near infrared, the thermal channel inverted the way MSU-MR sends it.
 */
function scene(channel: number, x: number, y: number): number {
  const land = Math.sin(x / 210 + Math.sin(y / 160)) + Math.cos(y / 120 - x / 400) > 0.4
  const cloud = Math.max(0, Math.sin(x / 90 + y / 70) * Math.cos(y / 55 - x / 300) + Math.sin((x + 2 * y) / 33) * 0.3)
  const base = [land ? 70 : 20, land ? 120 : 15, land ? 110 : 140][channel]
  let v = base + cloud * (channel === 2 ? 110 : 190)
  v += Math.sin(x * 0.37 + y * 0.11) * 3
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function rrcAt(t: number): number {
  const a = RRC_ALPHA
  if (Math.abs(t) < 1e-9) return 1 - a + (4 * a) / Math.PI
  if (Math.abs(Math.abs(4 * a * t) - 1) < 1e-9) {
    return (a / Math.SQRT2) * ((1 + 2 / Math.PI) * Math.sin(Math.PI / (4 * a)) + (1 - 2 / Math.PI) * Math.cos(Math.PI / (4 * a)))
  }
  return (Math.sin(Math.PI * t * (1 - a)) + 4 * a * t * Math.cos(Math.PI * t * (1 + a))) / (Math.PI * t * (1 - (4 * a * t) ** 2))
}

const PULSE = (() => {
  const n = 2 * RRC_SPAN * TABLE_RES + 1
  const t = new Float32Array(n + 1)
  for (let i = 0; i <= n; i++) t[i] = rrcAt(i / TABLE_RES - RRC_SPAN)
  return t
})()

function pulse(t: number): number {
  const p = (t + RRC_SPAN) * TABLE_RES
  if (p < 0 || p >= PULSE.length - 1) return 0
  const i = Math.floor(p)
  const f = p - i
  return PULSE[i] * (1 - f) + PULSE[i + 1] * f
}

export interface LrptDemoOptions {
  sampleRate?: number
  /** Scans to send, 8 rows each. A real pass gives a few hundred. */
  scans?: number
  /** Es/N0 in dB. */
  snrDb?: number
}

export class LrptDemoSource {
  readonly sampleRate: number
  private readonly scans: number
  private readonly noise: number
  private scan = 0
  private seq = 0
  private vcduCounter = 0
  private zone: number[] = []
  /** Offsets into the zone where a packet header starts. */
  private headers: number[] = []
  private nrzm = 0
  private convState = 0
  /** Rail values waiting to be shaped. symI[0] is symbol number symOffset. */
  private symI: number[] = []
  private symQ: number[] = []
  private symOffset = 0
  private finished = false
  private time = 0
  private phase = 0
  private q = quantTable(QUALITY)
  private rand = 0x1234567

  constructor(opts: LrptDemoOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 250000
    this.scans = opts.scans ?? 160
    const esn0 = 10 ** ((opts.snrDb ?? 9) / 10)
    // a unit rail symbol through the unnormalized pulse carries sps of energy
    // per rail, so the noise per rail scales the same way.
    const sps = this.sampleRate / SYMBOL_RATE
    this.noise = Math.sqrt(sps / esn0)
  }

  get progress(): number {
    return Math.min(1, this.scan / this.scans)
  }

  get done(): boolean {
    return this.finished && this.time / (this.sampleRate / SYMBOL_RATE) > this.symOffset + this.symI.length
  }

  /** The next stretch of signal as interleaved IQ. */
  read(ms: number): Float32Array {
    const n = Math.floor((ms / 1000) * this.sampleRate)
    const out = new Float32Array(n * 2)
    const sps = this.sampleRate / SYMBOL_RATE
    for (let k = 0; k < n; k++) {
      const tSym = this.time / sps
      const center = Math.floor(tSym)
      while (!this.finished && this.symOffset + this.symI.length <= center + RRC_SPAN + 2) {
        if (!this.produce()) this.finished = true
      }
      let si = 0
      let sq = 0
      for (let j = center - RRC_SPAN; j <= center + RRC_SPAN + 1; j++) {
        const idx = j - this.symOffset
        if (idx < 0 || idx >= this.symI.length) continue
        si += this.symI[idx] * pulse(tSym - j)
        sq += this.symQ[idx] * pulse(tSym - j - 0.5)
      }
      // a slow Doppler swing across the pass.
      const f = 1800 * Math.cos((this.time / this.sampleRate) * 0.02)
      this.phase += (2 * Math.PI * f) / this.sampleRate
      if (this.phase > Math.PI) this.phase -= 2 * Math.PI
      const c = Math.cos(this.phase)
      const s = Math.sin(this.phase)
      out[2 * k] = ((si + this.gauss() * this.noise) * c - (sq + this.gauss() * this.noise) * s) * 0.2
      out[2 * k + 1] = ((si + this.gauss() * this.noise) * s + (sq + this.gauss() * this.noise) * c) * 0.2
      this.time++
      const passed = center - RRC_SPAN - 2 - this.symOffset
      if (passed > 8192) {
        this.symI.splice(0, passed)
        this.symQ.splice(0, passed)
        this.symOffset += passed
      }
    }
    return out
  }

  private gauss(): number {
    let u = 0
    while (u === 0) u = this.random()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.random())
  }

  private random(): number {
    let x = this.rand
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.rand = x >>> 0
    return this.rand / 4294967296
  }

  /** Queues one more CADU worth of symbols. False when there is nothing left. */
  private produce(): boolean {
    while (this.zone.length < MPDU_ZONE && this.scan < this.scans) this.nextScan()
    if (this.zone.length === 0 && this.scan >= this.scans) {
      // idle symbols so the tail of the last frame clears the filters.
      for (let i = 0; i < 64; i++) {
        this.symI.push(1)
        this.symQ.push(-1)
      }
      return false
    }
    const cadu = new Uint8Array(CADU_BYTES)
    cadu[0] = ASM >>> 24
    cadu[1] = (ASM >>> 16) & 0xff
    cadu[2] = (ASM >>> 8) & 0xff
    cadu[3] = ASM & 0xff
    cadu[4] = 0x40 | (SCID >> 2)
    cadu[5] = ((SCID & 3) << 6) | 5
    cadu[6] = (this.vcduCounter >> 16) & 0xff
    cadu[7] = (this.vcduCounter >> 8) & 0xff
    cadu[8] = this.vcduCounter & 0xff
    this.vcduCounter = (this.vcduCounter + 1) & 0xffffff
    const take = Math.min(MPDU_ZONE, this.zone.length)
    const first = this.headers.find((h) => h < take)
    const fhp = first === undefined ? 0x7ff : first
    cadu[12] = (fhp >> 8) & 0x07
    cadu[13] = fhp & 0xff
    for (let i = 0; i < take; i++) cadu[14 + i] = this.zone[i]
    // a short final zone is padded with an idle packet's worth of fill.
    for (let i = take; i < MPDU_ZONE; i++) cadu[14 + i] = 0
    this.zone = this.zone.slice(take)
    this.headers = this.headers.filter((h) => h >= take).map((h) => h - take)
    rsEncodeCadu(cadu)
    for (let i = 4; i < CADU_BYTES; i++) cadu[i] ^= PN[(i - 4) % RS_N]

    const bits = new Uint8Array(CADU_BYTES * 8)
    for (let i = 0; i < bits.length; i++) {
      const b = (cadu[i >> 3] >> (7 - (i & 7))) & 1
      this.nrzm ^= b
      bits[i] = this.nrzm
    }
    const { out, state } = convEncode(bits, this.convState)
    this.convState = state
    for (let i = 0; i < out.length; i += 2) {
      this.symI.push(out[i] ? 1 : -1)
      this.symQ.push(out[i + 1] ? 1 : -1)
    }
    return true
  }

  private nextScan(): void {
    const row = this.scan * 8
    const ms = 36000000 + this.scan * 1220
    const strip = new Uint8Array(8 * STRIP_WIDTH)
    for (let c = 0; c < APIDS.length; c++) {
      for (let p = 0; p < MSUMR_WIDTH / STRIP_WIDTH; p++) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < STRIP_WIDTH; x++) {
            strip[y * STRIP_WIDTH + x] = scene(c, p * STRIP_WIDTH + x, row + y)
          }
        }
        const data = encodeStrip(strip, this.q)
        const body = [
          0, 0, (ms >>> 24) & 0xff, (ms >>> 16) & 0xff, (ms >>> 8) & 0xff, ms & 0xff, 0, 0,
          p * MCU_PER_PACKET, 0, 0, 0xff, 0xf0, QUALITY,
        ]
        this.packet(APIDS[c], [...body, ...data])
      }
    }
    // the cycle closes with a telemetry packet.
    this.packet(70, new Array(64).fill(0))
    this.scan++
  }

  private packet(apid: number, data: number[]): void {
    const len = data.length - 1
    this.headers.push(this.zone.length)
    this.zone.push(
      0x08 | ((apid >> 8) & 0x07),
      apid & 0xff,
      0xc0 | ((this.seq >> 8) & 0x3f),
      this.seq & 0xff,
      (len >> 8) & 0xff,
      len & 0xff,
      ...data,
    )
    this.seq = (this.seq + 1) & 0x3fff
  }
}

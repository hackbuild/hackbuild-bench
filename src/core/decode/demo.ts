/**
 * Synthetic transmissions for demo mode.
 *
 * A simulated radio has no picture and no packets on it, so these build the
 * real signal instead: a proper vis header and scan lines for sstv, a real
 * 2400 Hz subcarrier with sync trains for apt, a real ax.25 frame with its
 * check sequence for aprs, and real baudot characters for rtty. The decoders
 * then do exactly what they do on the air, so what appears on screen is a
 * decode and not a picture pasted in.
 */

import { ax25Fcs } from './aprs'
import { APT_LINE_WORDS, aptSyncBTemplate, aptSyncTemplate } from './apt'
import { baudotEncode } from './rtty'
import { SSTV_MODES, M1, R36, VIS, rgbToYcc } from './sstv'
import type { SstvModeId, SstvModeSpec } from './sstv'
import { clamp01 } from './signal'

export interface DemoAudioSource {
  readonly sampleRate: number
  /** Audio covering the next `ms` of transmission. Empty once done. */
  read(ms: number): Float32Array
  readonly done: boolean
  /** 0 to 1. */
  readonly progress: number
}

const DEMO_RATE = 48000

/** Serves a transmission that was cheap enough to render in one go. */
export class BufferedSource implements DemoAudioSource {
  readonly sampleRate: number
  private buf: Float32Array
  private pos = 0

  constructor(buf: Float32Array, sampleRate: number) {
    this.buf = buf
    this.sampleRate = sampleRate
  }

  get done(): boolean {
    return this.pos >= this.buf.length
  }

  get progress(): number {
    return this.buf.length ? this.pos / this.buf.length : 1
  }

  read(ms: number): Float32Array {
    const n = Math.round((this.sampleRate * ms) / 1000)
    const end = Math.min(this.buf.length, this.pos + n)
    const out = this.buf.subarray(this.pos, end)
    this.pos = end
    return out
  }
}

// ---------------------------------------------------------------------------
// sstv
// ---------------------------------------------------------------------------

/** Colour bars, a grey ramp, and a centred target. */
export function sstvTestPattern(width: number, height: number): Uint8Array {
  const px = new Uint8Array(width * height * 3)
  const bars = [
    [255, 255, 255],
    [255, 255, 0],
    [0, 255, 255],
    [0, 255, 0],
    [255, 0, 255],
    [255, 0, 0],
    [0, 0, 255],
    [12, 12, 12],
  ]
  const barsEnd = Math.floor(height * 0.42)
  const rampEnd = Math.floor(height * 0.55)
  const cx = (width - 1) / 2
  const cy = (height + rampEnd) / 2
  const radius = Math.min(width, height - rampEnd) * 0.3

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r: number
      let g: number
      let b: number
      if (y < barsEnd) {
        const c = bars[Math.min(bars.length - 1, Math.floor((x * bars.length) / width))]
        r = c[0]
        g = c[1]
        b = c[2]
      } else if (y < rampEnd) {
        const v = Math.round((x / (width - 1)) * 255)
        r = v
        g = v
        b = v
      } else {
        const checker = (Math.floor(x / 16) + Math.floor(y / 16)) % 2 === 0
        r = checker ? 30 : 18
        g = checker ? 30 : 18
        b = checker ? 36 : 22
        const d = Math.hypot(x - cx, y - cy)
        if (d < radius) {
          r = 254
          g = 3
          b = 134
        } else if (d < radius + 3) {
          r = 235
          g = 235
          b = 235
        }
        if (Math.abs(x - cx) < 1 || Math.abs(y - cy) < 1) {
          r = 210
          g = 210
          b = 210
        }
      }
      const o = (y * width + x) * 3
      px[o] = r
      px[o + 1] = g
      px[o + 2] = b
    }
  }
  return px
}

export class SstvDemoSource implements DemoAudioSource {
  readonly sampleRate: number
  readonly mode: SstvModeSpec

  private pattern: Uint8Array
  private ycc: Float32Array
  private phase = 0
  private tMs = 0
  private readonly headerMs = VIS.leaderMs * 2 + VIS.breakMs + VIS.bitMs * 10
  private readonly totalMs: number

  constructor(modeId: SstvModeId = 'robot36', sampleRate = DEMO_RATE) {
    this.mode = SSTV_MODES[modeId]
    this.sampleRate = sampleRate
    this.pattern = sstvTestPattern(this.mode.width, this.mode.height)
    this.ycc = new Float32Array(this.mode.width * this.mode.height * 3)
    for (let i = 0, o = 0; i < this.ycc.length; i += 3, o += 3) {
      const [y, cr, cb] = rgbToYcc(this.pattern[o], this.pattern[o + 1], this.pattern[o + 2])
      this.ycc[i] = y
      this.ycc[i + 1] = cr
      this.ycc[i + 2] = cb
    }
    this.totalMs = this.headerMs + this.mode.height * this.mode.lineMs + 200
  }

  get done(): boolean {
    return this.tMs >= this.totalMs
  }

  get progress(): number {
    return clamp01(this.tMs / this.totalMs)
  }

  read(ms: number): Float32Array {
    const n = Math.round((this.sampleRate * ms) / 1000)
    const out = new Float32Array(n)
    const dt = 1000 / this.sampleRate
    let o = 0
    while (o < n && this.tMs < this.totalMs) {
      const f = this.freqAt(this.tMs)
      out[o++] = Math.sin(this.phase) * 0.7
      this.phase += (2 * Math.PI * f) / this.sampleRate
      if (this.phase > Math.PI) this.phase -= 2 * Math.PI
      this.tMs += dt
    }
    return out.subarray(0, o)
  }

  private level(value: number): number {
    return 1500 + 800 * clamp01(value / 255)
  }

  private freqAt(t: number): number {
    if (t < this.headerMs) return this.headerFreq(t)
    const u = t - this.headerMs
    const row = Math.floor(u / this.mode.lineMs)
    if (row >= this.mode.height) return 1500
    return this.mode.id === 'martinm1'
      ? this.martinFreq(row, u - row * this.mode.lineMs)
      : this.robotFreq(row, u - row * this.mode.lineMs)
  }

  private headerFreq(t: number): number {
    const bitStart = VIS.leaderMs * 2 + VIS.breakMs
    if (t < VIS.leaderMs) return 1900
    if (t < VIS.leaderMs + VIS.breakMs) return 1200
    if (t < bitStart) return 1900
    const slot = Math.floor((t - bitStart) / VIS.bitMs)
    if (slot === 0 || slot >= 9) return 1200
    const code = this.mode.vis & 0x7f
    const index = slot - 1
    let parity = 0
    for (let i = 0; i < 7; i++) parity ^= (code >> i) & 1
    const bit = index === 7 ? parity : (code >> index) & 1
    return bit ? 1100 : 1300
  }

  private martinFreq(row: number, u: number): number {
    if (u < M1.sync) return 1200
    if (u < M1.green) return 1500
    if (u < M1.green + M1.scan) return this.channel(row, u - M1.green, 1)
    if (u < M1.blue) return 1500
    if (u < M1.blue + M1.scan) return this.channel(row, u - M1.blue, 2)
    if (u < M1.red) return 1500
    if (u < M1.red + M1.scan) return this.channel(row, u - M1.red, 0)
    return 1500
  }

  private channel(row: number, into: number, plane: number): number {
    const x = Math.min(this.mode.width - 1, Math.floor((into / M1.scan) * this.mode.width))
    return this.level(this.pattern[(row * this.mode.width + x) * 3 + plane])
  }

  private robotFreq(row: number, u: number): number {
    if (u < R36.sync) return 1200
    if (u < R36.yStart) return 1500
    if (u < R36.yStart + R36.yLen) {
      const x = Math.min(
        this.mode.width - 1,
        Math.floor(((u - R36.yStart) / R36.yLen) * this.mode.width),
      )
      return this.level(this.ycc[(row * this.mode.width + x) * 3])
    }
    // 1500 Hz on the separator says r-y follows, 2300 Hz says b-y.
    const blue = row % 2 === 1
    if (u < R36.sepStart) return 1500
    if (u < R36.sepStart + R36.sepLen) return blue ? 2300 : 1500
    if (u < R36.chromaStart) return 1900
    if (u < R36.chromaStart + R36.chromaLen) {
      const x = Math.min(
        this.mode.width - 1,
        Math.floor(((u - R36.chromaStart) / R36.chromaLen) * this.mode.width),
      )
      return this.level(this.ycc[(row * this.mode.width + x) * 3 + (blue ? 2 : 1)])
    }
    return 1500
  }
}

// ---------------------------------------------------------------------------
// apt
// ---------------------------------------------------------------------------

function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return s - Math.floor(s)
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash2(xi, yi)
  const b = hash2(xi + 1, yi)
  const c = hash2(xi, yi + 1)
  const d = hash2(xi + 1, yi + 1)
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
}

function fbm(x: number, y: number): number {
  let sum = 0
  let amp = 0.5
  let f = 1
  for (let i = 0; i < 4; i++) {
    sum += valueNoise(x * f, y * f) * amp
    amp *= 0.5
    f *= 2
  }
  return sum
}

const TELEMETRY = [0.5, 0.3, 0.1, 0.9, 0.75, 0.55, 0.35, 0.15]

export class AptDemoSource implements DemoAudioSource {
  readonly sampleRate: number

  private words = new Float32Array(APT_LINE_WORDS)
  private cached = -1
  private wordPos = 0
  private phase = 0
  private readonly totalWords: number
  private readonly syncA = aptSyncTemplate()
  private readonly syncB = aptSyncBTemplate()

  constructor(lines = 240, sampleRate = DEMO_RATE) {
    this.totalWords = lines * APT_LINE_WORDS
    this.sampleRate = sampleRate
  }

  get done(): boolean {
    return this.wordPos >= this.totalWords
  }

  get progress(): number {
    return clamp01(this.wordPos / this.totalWords)
  }

  read(ms: number): Float32Array {
    const n = Math.round((this.sampleRate * ms) / 1000)
    const out = new Float32Array(n)
    const carrier = (2 * Math.PI * 2400) / this.sampleRate
    const advance = 4160 / this.sampleRate
    let o = 0
    while (o < n && this.wordPos < this.totalWords) {
      const idx = Math.floor(this.wordPos)
      const line = Math.floor(idx / APT_LINE_WORDS)
      if (line !== this.cached) {
        this.buildLine(line)
        this.cached = line
      }
      out[o++] = this.words[idx % APT_LINE_WORDS] * Math.cos(this.phase) * 0.8
      this.phase += carrier
      if (this.phase > Math.PI) this.phase -= 2 * Math.PI
      this.wordPos += advance
    }
    return out.subarray(0, o)
  }

  private buildLine(line: number): void {
    const w = this.words
    const wedge = Math.floor(line / 8) % 16
    const telemetry = wedge < 8 ? (wedge + 1) / 8 : TELEMETRY[wedge - 8]

    for (let i = 0; i < 39; i++) w[i] = this.syncA[i] ? 0.95 : 0.05
    for (let i = 39; i < 86; i++) w[i] = 0.06
    for (let i = 0; i < 909; i++) w[86 + i] = this.scene(i, line, false)
    for (let i = 995; i < 1040; i++) w[i] = telemetry
    for (let i = 0; i < 39; i++) w[1040 + i] = this.syncB[i] ? 0.95 : 0.05
    for (let i = 1079; i < 1126; i++) w[i] = 0.06
    for (let i = 0; i < 909; i++) w[1126 + i] = this.scene(i, line, true)
    for (let i = 2035; i < 2080; i++) w[i] = telemetry
  }

  /** Land, sea, and cloud, viewed twice: once as light, once as heat. */
  private scene(col: number, line: number, thermal: boolean): number {
    const nx = (col / 909) * 5
    const ny = line / 70
    const cloud = Math.max(0, fbm(nx * 1.6 + 3, ny * 1.6) - 0.42) * 2.4
    const land = fbm(nx * 0.6 + 11, ny * 0.6 + 5) > 0.52 ? 0.34 : 0.1
    const value = thermal ? 0.22 + cloud * 0.9 - land * 0.12 : land + cloud
    return 0.05 + 0.9 * clamp01(value)
  }
}

// ---------------------------------------------------------------------------
// aprs
// ---------------------------------------------------------------------------

export interface AprsDemoFrame {
  source: string
  destination: string
  path: string[]
  info: string
}

const APRS_DEMO_FRAMES: AprsDemoFrame[] = [
  {
    source: 'N0CALL-9',
    destination: 'APRS',
    path: ['WIDE1-1', 'WIDE2-1'],
    info: '!3327.66N/11157.18W>082/019/A=001240 rolling on the loop 101',
  },
  {
    source: 'KD7XYZ-5',
    destination: 'APDW16',
    path: ['WIDE2-1'],
    info: '=3329.10N/11202.44W-hackbuild bench, shack station',
  },
  {
    source: 'W1AW-10',
    destination: 'APRS',
    path: ['WIDE1-1'],
    info: ':N0CALL-9 :meet at the trailhead at 0800{012',
  },
  {
    source: 'KE7ABC',
    destination: 'APRS',
    path: [],
    info: '>monitoring 146.520, digipeater on the ridge',
  },
  {
    source: 'N7DIG-3',
    destination: 'APRS',
    path: ['WIDE2-2'],
    info: '!3331.02N/11149.77W#PHG5360 wide area digi',
  },
  {
    source: 'AE0BAL-11',
    destination: 'APRS',
    path: ['WIDE2-1'],
    info: '/092345z3335.88N/11208.10WO180/042/A=047800 balloon ascending',
  },
]

function encodeAddress(text: string, last: boolean): number[] {
  const m = /^([A-Z0-9]{1,6})(?:-(\d{1,2}))?$/.exec(text.toUpperCase())
  const call = (m?.[1] ?? 'NOCALL').padEnd(6, ' ')
  const ssid = Number(m?.[2] ?? 0) & 0x0f
  const out: number[] = []
  for (let i = 0; i < 6; i++) out.push(call.charCodeAt(i) << 1)
  out.push(0x60 | (ssid << 1) | (last ? 1 : 0))
  return out
}

/** A ui frame with its check sequence, ready for the hdlc layer. */
export function buildAx25Frame(frame: AprsDemoFrame): Uint8Array {
  const body: number[] = []
  body.push(...encodeAddress(frame.destination, false))
  body.push(...encodeAddress(frame.source, frame.path.length === 0))
  frame.path.forEach((hop, i) => {
    body.push(...encodeAddress(hop, i === frame.path.length - 1))
  })
  body.push(0x03, 0xf0)
  for (let i = 0; i < frame.info.length; i++) body.push(frame.info.charCodeAt(i) & 0xff)

  const bytes = new Uint8Array(body.length + 2)
  bytes.set(body)
  const fcs = ax25Fcs(bytes, body.length)
  bytes[body.length] = fcs & 0xff
  bytes[body.length + 1] = (fcs >> 8) & 0xff
  return bytes
}

function hdlcBits(frame: Uint8Array, leadFlags: number, tailFlags: number): number[] {
  const bits: number[] = []
  const flag = () => {
    for (let i = 0; i < 8; i++) bits.push((0x7e >> i) & 1)
  }
  for (let i = 0; i < leadFlags; i++) flag()
  let ones = 0
  for (const b of frame) {
    for (let i = 0; i < 8; i++) {
      const bit = (b >> i) & 1
      bits.push(bit)
      if (bit) {
        // five ones in a row and a zero goes in so the flag stays unique.
        if (++ones === 5) {
          bits.push(0)
          ones = 0
        }
      } else {
        ones = 0
      }
    }
  }
  for (let i = 0; i < tailFlags; i++) flag()
  return bits
}

function afskRender(bits: number[], sampleRate: number, gapMs: number): Float32Array {
  const spb = sampleRate / 1200
  const gap = Math.round((sampleRate * gapMs) / 1000)
  const out = new Float32Array(Math.ceil(bits.length * spb) + gap + 8)
  let phase = 0
  let level = 1
  let o = 0
  let carry = 0
  for (const bit of bits) {
    // nrzi: a zero flips the tone, a one leaves it alone.
    if (!bit) level ^= 1
    const hz = level ? 1200 : 2200
    carry += spb
    const count = Math.floor(carry)
    carry -= count
    for (let i = 0; i < count && o < out.length; i++) {
      out[o++] = Math.sin(phase) * 0.7
      phase += (2 * Math.PI * hz) / sampleRate
      if (phase > Math.PI) phase -= 2 * Math.PI
    }
  }
  return out.subarray(0, Math.min(out.length, o + gap))
}

export class AprsDemoSource extends BufferedSource {
  constructor(sampleRate = DEMO_RATE) {
    const blocks = APRS_DEMO_FRAMES.map((f, i) =>
      afskRender(hdlcBits(buildAx25Frame(f), 24, 4), sampleRate, 300 + i * 60),
    )
    let total = 0
    for (const b of blocks) total += b.length
    const buf = new Float32Array(total)
    let o = 0
    for (const b of blocks) {
      buf.set(b, o)
      o += b.length
    }
    super(buf, sampleRate)
  }
}

// ---------------------------------------------------------------------------
// rtty
// ---------------------------------------------------------------------------

const RTTY_DEMO_TEXT =
  'RYRYRYRYRYRY CQ CQ CQ DE W1AW W1AW W1AW K\r\n' +
  'HACKBUILD BENCH RTTY DECODER 45.45 BAUD 170 SHIFT\r\n' +
  'QSL PSE K\r\n'

export class RttyDemoSource extends BufferedSource {
  constructor(markHz = 2125, shiftHz = 170, baud = 45.45, sampleRate = DEMO_RATE) {
    const codes = baudotEncode(RTTY_DEMO_TEXT)
    const spb = sampleRate / baud
    const idle = Math.round(spb * 10)
    const total = idle + Math.ceil(codes.length * spb * 7.5) + idle
    const buf = new Float32Array(total)

    let phase = 0
    let o = 0
    const tone = (mark: boolean, samples: number) => {
      const hz = mark ? markHz : markHz + shiftHz
      for (let i = 0; i < samples && o < total; i++) {
        buf[o++] = Math.sin(phase) * 0.7
        phase += (2 * Math.PI * hz) / sampleRate
        if (phase > Math.PI) phase -= 2 * Math.PI
      }
    }

    tone(true, idle)
    for (const code of codes) {
      tone(false, Math.round(spb))
      for (let b = 0; b < 5; b++) tone(((code >> b) & 1) === 1, Math.round(spb))
      tone(true, Math.round(spb * 1.5))
    }
    tone(true, idle)
    super(buf.subarray(0, o), sampleRate)
  }
}

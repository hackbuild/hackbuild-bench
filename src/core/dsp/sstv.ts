/**
 * Slow scan television encoder.
 *
 * An image becomes an audio tone sequence: a vis header that names the mode,
 * then one tone burst per pixel where 1500 Hz is black and 2300 Hz is white.
 * The audio is what goes into an fm transmitter, exactly as it would come out
 * of a microphone socket.
 *
 * Timings follow the JVComm and MMSSTV mode tables. Pixel durations are
 * fractions of a millisecond, so the writer tracks a fractional sample cursor
 * rather than rounding each burst, which is what stops the picture slanting.
 */

const TWO_PI = Math.PI * 2

/** Tone the receiver expects to see for black and for white. */
const BLACK_HZ = 1500
const WHITE_HZ = 2300
const SYNC_HZ = 1200

export type SstvMode = 'robot36' | 'martinm1'

export interface SstvSpec {
  id: SstvMode
  label: string
  width: number
  height: number
  /** vis code the header spells out, seven bits plus even parity. */
  vis: number
  /** Whole transmission including the header. */
  seconds: number
  blurb: string
}

/** Header: two 1900 Hz leaders, a start bit, seven vis bits, a stop bit. */
const HEADER_MS = 300 + 10 + 300 + 30 + 8 * 30 + 30

const MARTIN_LINE_MS = 4.862 + 0.572 + 3 * (146.432 + 0.572)
const ROBOT_LINE_MS = 9 + 3 + 88 + 4.5 + 1.5 + 44

export const SSTV_MODES: SstvSpec[] = [
  {
    id: 'robot36',
    label: 'robot 36',
    width: 320,
    height: 240,
    vis: 8,
    seconds: (HEADER_MS + 240 * ROBOT_LINE_MS) / 1000,
    blurb: 'colour in 36 seconds, the mode weather satellites and repeaters use most',
  },
  {
    id: 'martinm1',
    label: 'martin m1',
    width: 320,
    height: 256,
    vis: 44,
    seconds: (HEADER_MS + 256 * MARTIN_LINE_MS) / 1000,
    blurb: 'full colour, 114 seconds, every decoder handles it',
  },
]

export function sstvSpec(mode: SstvMode): SstvSpec {
  return SSTV_MODES.find((m) => m.id === mode) ?? SSTV_MODES[0]
}

/** Seconds the transmission takes, for the panel to state before it starts. */
export function sstvSeconds(mode: SstvMode): number {
  return sstvSpec(mode).seconds
}

/**
 * Phase continuous tone writer over a preallocated buffer. Durations are in
 * milliseconds and accumulate as floats, so no burst drifts from its slot.
 */
class ToneWriter {
  readonly samples: Float32Array
  private readonly rate: number
  private readonly peak: number
  private cursor = 0
  private phase = 0
  private end = 0

  constructor(rate: number, seconds: number, peak = 0.85) {
    this.rate = rate
    this.peak = peak
    this.samples = new Float32Array(Math.ceil(rate * (seconds + 0.5)))
  }

  tone(freqHz: number, ms: number): void {
    const start = Math.round(this.cursor)
    this.cursor += (ms / 1000) * this.rate
    const stop = Math.min(Math.round(this.cursor), this.samples.length)
    const step = (TWO_PI * freqHz) / this.rate
    for (let i = start; i < stop; i++) {
      this.samples[i] = Math.sin(this.phase) * this.peak
      this.phase += step
      if (this.phase > TWO_PI) this.phase -= TWO_PI
    }
    this.end = Math.max(this.end, stop)
  }

  /** Level 0 to 255 as its tone. */
  level(value: number, ms: number): void {
    const v = value < 0 ? 0 : value > 255 ? 255 : value
    this.tone(BLACK_HZ + ((WHITE_HZ - BLACK_HZ) * v) / 255, ms)
  }

  done(): Float32Array {
    return this.samples.subarray(0, this.end)
  }
}

/** Leader, break, leader, then the vis code least significant bit first. */
function writeHeader(w: ToneWriter, vis: number): void {
  w.tone(1900, 300)
  w.tone(1200, 10)
  w.tone(1900, 300)
  w.tone(1200, 30)

  let parity = 0
  for (let i = 0; i < 7; i++) {
    const bit = (vis >> i) & 1
    parity ^= bit
    w.tone(bit ? 1100 : 1300, 30)
  }
  w.tone(parity ? 1100 : 1300, 30)
  w.tone(1200, 30)
}

interface Rgb {
  r: number
  g: number
  b: number
}

/** Nearest neighbour read, so an image of any size still encodes. */
function sample(image: ImageData, x: number, y: number, width: number, height: number): Rgb {
  const sx = Math.min(image.width - 1, Math.floor((x * image.width) / width))
  const sy = Math.min(image.height - 1, Math.floor((y * image.height) / height))
  const i = (sy * image.width + sx) * 4
  return { r: image.data[i], g: image.data[i + 1], b: image.data[i + 2] }
}

function luma(p: Rgb): number {
  return 16 + 0.003906 * (65.738 * p.r + 129.057 * p.g + 25.064 * p.b)
}

function chromaR(p: Rgb): number {
  return 128 + 0.003906 * (112.439 * p.r - 94.154 * p.g - 18.285 * p.b)
}

function chromaB(p: Rgb): number {
  return 128 + 0.003906 * (-37.945 * p.r - 74.494 * p.g + 112.439 * p.b)
}

/**
 * Martin M1. Sync, porch, then green, blue and red scans of 320 pixels each
 * with a 1500 Hz gap after every channel.
 */
function encodeMartin(image: ImageData, spec: SstvSpec, rate: number): Float32Array {
  const w = new ToneWriter(rate, spec.seconds)
  const perPixel = 0.4576
  writeHeader(w, spec.vis)

  for (let y = 0; y < spec.height; y++) {
    w.tone(SYNC_HZ, 4.862)
    w.tone(BLACK_HZ, 0.572)
    for (const channel of ['g', 'b', 'r'] as const) {
      for (let x = 0; x < spec.width; x++) {
        const p = sample(image, x, y, spec.width, spec.height)
        w.level(channel === 'g' ? p.g : channel === 'b' ? p.b : p.r, perPixel)
      }
      w.tone(BLACK_HZ, 0.572)
    }
  }
  return w.done()
}

/**
 * Robot 36. Luminance every line, and one colour difference per line taken as
 * the average over the line pair, which is where the 36 seconds comes from.
 */
function encodeRobot36(image: ImageData, spec: SstvSpec, rate: number): Float32Array {
  const w = new ToneWriter(rate, spec.seconds)
  const perLuma = 88 / spec.width
  const perChroma = 44 / spec.width
  writeHeader(w, spec.vis)

  for (let y = 0; y < spec.height; y++) {
    const even = y % 2 === 0
    const pair = Math.min(spec.height - 1, even ? y + 1 : y - 1)

    w.tone(SYNC_HZ, 9)
    w.tone(BLACK_HZ, 3)
    for (let x = 0; x < spec.width; x++) {
      w.level(luma(sample(image, x, y, spec.width, spec.height)), perLuma)
    }

    w.tone(even ? 1500 : 2300, 4.5)
    w.tone(1900, 1.5)
    for (let x = 0; x < spec.width; x++) {
      const a = sample(image, x, y, spec.width, spec.height)
      const b = sample(image, x, pair, spec.width, spec.height)
      const value = even
        ? (chromaR(a) + chromaR(b)) / 2
        : (chromaB(a) + chromaB(b)) / 2
      w.level(value, perChroma)
    }
  }
  return w.done()
}

/**
 * An image as the audio a receiver decodes back into a picture. Feed the
 * result to an fm modulator.
 */
export function encodeSstv(image: ImageData, mode: SstvMode, audioRate: number): Float32Array {
  const spec = sstvSpec(mode)
  return spec.id === 'martinm1'
    ? encodeMartin(image, spec, audioRate)
    : encodeRobot36(image, spec, audioRate)
}

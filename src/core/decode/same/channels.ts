import { Fft, makeWindow } from '../../dsp/fft'

/** The seven NOAA Weather Radio channels, in Hz. */
export const NOAA_CHANNELS: readonly number[] = [
  162_400_000, 162_425_000, 162_450_000, 162_475_000, 162_500_000, 162_525_000, 162_550_000,
]

/**
 * Where to centre the radio so every channel sits inside the window and none
 * sits on the middle, where a zero IF tuner leaves its DC spike.
 */
export const NOAA_CENTER_HZ = 162_225_000
export const NOAA_RATE = 1_024_000

const SIZE = 4096
/** NOAA transmitters run 5 kHz deviation, so 12 kHz holds a channel. */
const CHANNEL_HZ = 12_000

/**
 * Averaged power in each channel of a window, so the strongest transmitter
 * in range can be picked without retuning.
 */
export class ChannelMeter {
  private readonly fft = new Fft(SIZE)
  private readonly win = makeWindow(SIZE, 'hann')
  private readonly re = new Float32Array(SIZE)
  private readonly im = new Float32Array(SIZE)
  private readonly sums: Float64Array
  private readonly floor: Float64Array
  private frames = 0
  readonly channels: readonly number[]

  constructor(channels: readonly number[] = NOAA_CHANNELS) {
    this.channels = channels
    this.sums = new Float64Array(channels.length)
    this.floor = new Float64Array(1)
  }

  reset(): void {
    this.sums.fill(0)
    this.floor.fill(0)
    this.frames = 0
  }

  get count(): number {
    return this.frames
  }

  /** One transform from the start of the chunk. */
  push(iq: Float32Array, sampleRate: number, centerHz: number): void {
    if (iq.length < SIZE * 2) return
    for (let i = 0; i < SIZE; i++) {
      this.re[i] = iq[2 * i] * this.win[i]
      this.im[i] = iq[2 * i + 1] * this.win[i]
    }
    this.fft.transform(this.re, this.im)
    const binHz = sampleRate / SIZE
    const power = (k: number) => {
      const b = (k + SIZE) % SIZE
      return this.re[b] * this.re[b] + this.im[b] * this.im[b]
    }
    this.channels.forEach((hz, c) => {
      const mid = Math.round((hz - centerHz) / binHz)
      const half = Math.max(1, Math.round(CHANNEL_HZ / 2 / binHz))
      if (Math.abs(mid) + half >= SIZE / 2) return
      let p = 0
      for (let k = mid - half; k <= mid + half; k++) p += power(k)
      this.sums[c] += p / (2 * half + 1)
    })
    // a band clear of every channel and of the centre stands in for the floor.
    const quiet = Math.round(-200_000 / binHz)
    let q = 0
    for (let k = quiet - 20; k <= quiet + 20; k++) q += power(k)
    this.floor[0] += q / 41
    this.frames++
  }

  /** Each channel's level over the floor in dB, null for one outside the window. */
  levels(sampleRate: number, centerHz: number): Array<number | null> {
    const floor = this.floor[0] / Math.max(1, this.frames)
    return this.channels.map((hz, c) => {
      if (Math.abs(hz - centerHz) + CHANNEL_HZ >= sampleRate / 2) return null
      if (!this.frames) return null
      return 10 * Math.log10((this.sums[c] / this.frames + 1e-30) / (floor + 1e-30))
    })
  }
}

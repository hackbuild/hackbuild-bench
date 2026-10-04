/**
 * Tracks a display window that follows the data.
 *
 * Signal levels differ by orders of magnitude between an rtl-sdr, a hackrf,
 * and a synthetic source, so a fixed dB window either clips or washes out. The
 * floor comes from a low percentile of the frame and the ceiling from its
 * peak, both smoothed so the picture does not flicker frame to frame.
 */
export class AutoRange {
  private floor: number | null = null
  private ceil: number | null = null
  private readonly alpha: number

  constructor(alpha = 0.12) {
    this.alpha = alpha
  }

  /** Feeds a frame and returns the window to draw it in. */
  update(bins: Float32Array): { minDb: number; maxDb: number } {
    if (!bins.length) return { minDb: this.floor ?? -100, maxDb: this.ceil ?? -10 }

    // a strided sample is enough to find the noise floor and costs far less
    // than sorting every bin. the peak has to see every bin, since a carrier
    // can be one bin wide and the ceiling has to clear what the trace draws.
    const stride = Math.max(1, Math.floor(bins.length / 256))
    const sample: number[] = []
    let peak = -Infinity
    for (let i = 0; i < bins.length; i++) {
      const v = bins[i]
      if (!Number.isFinite(v)) continue
      if (v > peak) peak = v
      if (i % stride === 0) sample.push(v)
    }
    if (!sample.length || !Number.isFinite(peak)) {
      return { minDb: this.floor ?? -100, maxDb: this.ceil ?? -10 }
    }
    sample.sort((a, b) => a - b)
    const p30 = sample[Math.floor(sample.length * 0.3)]

    const wantFloor = p30 - 3
    const wantCeil = Math.max(peak + 2, wantFloor + 12)

    this.floor = this.floor === null ? wantFloor : this.floor + (wantFloor - this.floor) * this.alpha
    this.ceil = this.ceil === null ? wantCeil : this.ceil + (wantCeil - this.ceil) * this.alpha

    return { minDb: this.floor, maxDb: this.ceil }
  }

  reset(): void {
    this.floor = null
    this.ceil = null
  }
}

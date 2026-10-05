import { CHANNEL_HZ, PILOT_OFFSET_HZ, TV_CHANNELS } from './index'

/**
 * A made up tv band for demo mode: a few ATSC 1.0 stations at different
 * strengths, each a pilot over a raised data band, and one ATSC 3.0
 * station with the band and no pilot. The radio reads 9 ppm slow, so the
 * calibration has something to find.
 */
const STATIONS: Array<{ channel: number; pilotDb: number; dataDb: number; pilot: boolean }> = [
  { channel: 8, pilotDb: 42, dataDb: 12, pilot: true },
  { channel: 10, pilotDb: 30, dataDb: 6, pilot: true },
  { channel: 15, pilotDb: 36, dataDb: 9, pilot: true },
  { channel: 20, pilotDb: 0, dataDb: 8, pilot: false },
  { channel: 24, pilotDb: 24, dataDb: 3, pilot: true },
  { channel: 31, pilotDb: 18, dataDb: 0, pilot: true },
]
const DEMO_PPM = -9
const NOISE = 0.01

export class TvDemoSource {
  private n = 0
  /** One pole low pass state for the data band, per station in view. */
  private lp = new Map<number, { i: number; q: number }>()

  read(ms: number, centerHz: number, rate: number): Float32Array {
    const count = Math.max(1, Math.round((rate * ms) / 1000))
    const out = new Float32Array(count * 2)
    for (let k = 0; k < count; k++) {
      out[2 * k] = NOISE * (Math.random() + Math.random() + Math.random() - 1.5) * 2
      out[2 * k + 1] = NOISE * (Math.random() + Math.random() + Math.random() - 1.5) * 2
    }
    for (const s of STATIONS) {
      const ch = TV_CHANNELS.find((c) => c.number === s.channel)
      // the demo band is white, so a station is only drawn into windows centred inside it.
      if (!ch || centerHz < ch.lowHz || centerHz > ch.lowHz + CHANNEL_HZ) continue
      // a slow crystal tunes low, so everything lands high.
      const drift = -DEMO_PPM * 1e-6
      const pilotOff = (ch.lowHz + PILOT_OFFSET_HZ) * (1 + drift) - centerHz
      const dataOff = (ch.lowHz + CHANNEL_HZ / 2) * (1 + drift) - centerHz
      // the pilot's bin level over the noise bins, for a 16k transform.
      const pa = (NOISE * Math.pow(10, s.pilotDb / 20)) / Math.sqrt(16_384) * 2.4
      const da = NOISE * Math.pow(10, s.dataDb / 20) * 3.5
      const state = this.lp.get(s.channel) ?? { i: 0, q: 0 }
      const alpha = 0.9
      for (let k = 0; k < count; k++) {
        const t = (this.n + k) / rate
        if (s.pilot) {
          const ph = 2 * Math.PI * pilotOff * t
          out[2 * k] += pa * Math.cos(ph)
          out[2 * k + 1] += pa * Math.sin(ph)
        }
        state.i = state.i * (1 - alpha) + alpha * (Math.random() - 0.5)
        state.q = state.q * (1 - alpha) + alpha * (Math.random() - 0.5)
        // the band is mixed to where the channel sits, and only its own 6 MHz counts.
        const ph = 2 * Math.PI * dataOff * t
        const c = Math.cos(ph)
        const sn = Math.sin(ph)
        const bandI = state.i * c - state.q * sn
        const bandQ = state.i * sn + state.q * c
        out[2 * k] += da * bandI
        out[2 * k + 1] += da * bandQ
      }
      this.lp.set(s.channel, state)
    }
    this.n += count
    return out
  }
}

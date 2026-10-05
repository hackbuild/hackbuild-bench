import { ModeSDemod } from './demod'
import type { DemodFrame, DemodRate } from './demod'
import { decodeFrame, scoreFrame } from './message'
import type { ModeSMessage } from './message'
import { AircraftTable } from './tracker'
import type { Aircraft } from './tracker'
import type { LatLon } from './cpr'

export type { Aircraft } from './tracker'
export type { ModeSMessage } from './message'
export type { LatLon } from './cpr'
export { AGE_OUT_MS, MAX_RANGE_KM } from './tracker'
export { bearingDeg, distanceKm } from './cpr'

/** Mode S replies are on 1090 MHz, ADS-B included. */
export const ADSB_HZ = 1_090_000_000
/** The rate the panel asks for. An RTL-SDR has no exact 2 Msps. */
export const ADSB_RATE = 2_400_000

export function isDemodRate(rate: number): rate is DemodRate {
  return rate === 2_000_000 || rate === 2_400_000
}

export interface DecodedMessage {
  message: ModeSMessage
  aircraft: Aircraft
  signalDb: number
  /** On the sample clock, in ms. */
  at: number
}

/**
 * Mode S from IQ to aircraft: demodulation, parity, field decoding and the
 * aircraft table, with no dependence on where the IQ came from.
 */
export class AdsbDecoder {
  readonly table = new AircraftTable()
  onMessage: ((d: DecodedMessage) => void) | null = null

  /** Messages accepted since the last reset. */
  messages = 0
  /** Accepted after a one bit repair. */
  repaired = 0
  /** Samples handed over at a rate the demodulator does not handle. */
  unsupportedRate = 0

  private demod: ModeSDemod | null = null
  private startMs: number
  /** Samples before the current demodulator, so the clock survives a rate change. */
  private elapsedMs = 0

  constructor(startMs = Date.now()) {
    this.startMs = startMs
  }

  set receiver(p: LatLon | null) {
    this.table.receiver = p
  }

  get receiver(): LatLon | null {
    return this.table.receiver
  }

  get rate(): number {
    return this.demod?.rate ?? 0
  }

  get preambles(): number {
    return this.demod?.preambles ?? 0
  }

  /** The sample clock, in ms on the same footing as Date.now() at the start. */
  now(): number {
    const d = this.demod
    return this.startMs + this.elapsedMs + (d ? (d.samples / d.rate) * 1000 : 0)
  }

  /**
   * Interleaved IQ as floats in about -1..1. `dropped` is how many samples
   * the source lost before this block, which keeps the clock honest and stops
   * a frame being stitched across the hole.
   */
  feed(iq: Float32Array, sampleRate: number, dropped = 0): void {
    if (!isDemodRate(sampleRate)) {
      this.unsupportedRate += iq.length >> 1
      return
    }
    if (!this.demod || this.demod.rate !== sampleRate) {
      if (this.demod) this.elapsedMs += (this.demod.samples / this.demod.rate) * 1000
      this.demod = new ModeSDemod(sampleRate, (raw) => scoreFrame(raw, this.table), (f) => this.frame(f))
    }
    if (dropped > 0) {
      this.elapsedMs += (dropped / sampleRate) * 1000
      this.demod.reset()
    }
    this.table.setClock(this.now())
    this.demod.feed(iq)
    this.table.setClock(this.now())
  }

  /** Ages out silent aircraft. Call about once a second. */
  prune(): number {
    this.table.setClock(this.now())
    return this.table.prune()
  }

  reset(): void {
    this.table.clear()
    this.messages = 0
    this.repaired = 0
    this.unsupportedRate = 0
  }

  /** Plain copies of the table, safe to hand across a worker boundary. */
  snapshot(): Aircraft[] {
    return this.table.list().map((a) => {
      const { even: _e, odd: _o, disagreed: _d, ...plain } = a as Aircraft & Record<string, unknown>
      return plain as Aircraft
    })
  }

  private frame(f: DemodFrame): void {
    const m = decodeFrame(f.raw, f.score)
    if (!m) return
    const d = this.demod
    const at = this.startMs + this.elapsedMs + (d ? (f.sample / d.rate) * 1000 : 0)
    this.table.setClock(at)
    this.messages++
    if (m.corrected) this.repaired++
    const aircraft = this.table.update(m, f.signalDb)
    this.onMessage?.({ message: m, aircraft, signalDb: f.signalDb, at })
  }
}

/** What a decoded message carries onto the bus as a packet artifact. */
export interface AdsbPacket {
  bytes: Uint8Array
  fields: Record<string, unknown>
  summary: string
  rssi: number
}

export function packetOf(d: DecodedMessage): AdsbPacket {
  const m = d.message
  const a = d.aircraft
  const fields: Record<string, unknown> = { df: m.df, icao: a.hex }
  if (m.tc !== undefined) fields.tc = m.tc
  if (m.callsign) fields.callsign = m.callsign
  if (m.altitudeFt !== undefined) fields.altitudeFt = m.altitudeFt
  if (m.squawk) fields.squawk = m.squawk
  if (m.groundSpeedKt !== undefined) fields.groundSpeedKt = m.groundSpeedKt
  if (m.trackDeg !== undefined) fields.trackDeg = Math.round(m.trackDeg * 10) / 10
  if (m.verticalRateFpm !== undefined) fields.verticalRateFpm = m.verticalRateFpm
  if (m.cpr && a.position && a.positionAt === d.at) {
    fields.lat = Math.round(a.position.lat * 1e5) / 1e5
    fields.lon = Math.round(a.position.lon * 1e5) / 1e5
  }
  if (m.corrected) fields.corrected = m.corrected
  const bits = [a.hex, `df${m.df}`]
  if (m.callsign) bits.push(m.callsign)
  if (m.altitudeFt !== undefined) bits.push(`${m.altitudeFt} ft`)
  if (m.squawk) bits.push(`squawk ${m.squawk}`)
  if (m.groundSpeedKt !== undefined) bits.push(`${m.groundSpeedKt} kt`)
  return {
    bytes: m.bytes.slice(),
    fields,
    summary: bits.join(' '),
    rssi: Math.round(d.signalDb * 10) / 10,
  }
}

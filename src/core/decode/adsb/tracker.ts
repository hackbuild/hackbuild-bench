import { cprGlobal, cprLocal, distanceKm } from './cpr'
import type { LatLon } from './cpr'
import { NON_TRANSPONDER } from './message'
import type { IcaoFilter, ModeSMessage } from './message'

/**
 * The aircraft table. One entry per address, built up from every message
 * that address sends, and dropped after a minute of silence.
 *
 * Times are on the decoder's sample clock, so a recording replayed faster
 * than real time pairs and ages its reports the way live air would.
 */

export interface Aircraft {
  icao: number
  hex: string
  callsign?: string
  squawk?: string
  category?: string
  altitudeFt?: number
  altitudeGnss?: boolean
  groundSpeedKt?: number
  trackDeg?: number
  headingDeg?: number
  airspeedKt?: number
  verticalRateFpm?: number
  onGround?: boolean
  position?: LatLon
  positionAt?: number
  /** How the last position was resolved. */
  positionBy?: 'global' | 'aircraft' | 'receiver'
  messages: number
  firstSeen: number
  lastSeen: number
  signalDb: number
  /** Last DF that carried this address. */
  lastDf: number
}

interface CprHeld {
  lat: number
  lon: number
  at: number
}

interface Track extends Aircraft {
  even?: CprHeld
  odd?: CprHeld
  /** Global decodes in a row that disagreed with the held position. */
  disagreed: number
}

/** Silence after which an aircraft leaves the table. */
export const AGE_OUT_MS = 60_000
/** dump1090's window for remembering a checked address. */
const ICAO_TTL_MS = 60_000
/** Even and odd reports further apart than this are not paired. */
const PAIR_MS = 10_000
/** Beyond this from the receiver a position is treated as a bad decode. dump1090-fa's default. */
export const MAX_RANGE_KM = 300 * 1.852
/** Half a latitude zone, the furthest a local decode stays unambiguous. */
const LOCAL_RANGE_KM = 180 * 1.852
/** A position this stale is no longer a reference for a local decode. */
const REF_MAX_AGE_MS = 10 * 60_000
/** Faster than any airliner with margin for the zone rounding, in km per second. */
const MAX_SPEED_KMS = 0.8

export class AircraftTable implements IcaoFilter {
  receiver: LatLon | null = null
  private tracks = new Map<number, Track>()
  private checked = new Map<number, number>()
  private clock = 0

  /** True when the address was heard on a checked frame within the last minute. */
  has(key: number): boolean {
    const at = this.checked.get(key)
    return at !== undefined && this.clock - at <= ICAO_TTL_MS
  }

  setClock(ms: number): void {
    this.clock = ms
  }

  get size(): number {
    return this.tracks.size
  }

  list(): Aircraft[] {
    return [...this.tracks.values()]
  }

  get(icao: number): Aircraft | undefined {
    return this.tracks.get(icao)
  }

  clear(): void {
    this.tracks.clear()
    this.checked.clear()
  }

  /** Drops aircraft silent for longer than AGE_OUT_MS. Returns how many went. */
  prune(): number {
    let gone = 0
    for (const [k, t] of this.tracks) {
      if (this.clock - t.lastSeen > AGE_OUT_MS) {
        this.tracks.delete(k)
        gone++
      }
    }
    for (const [k, at] of this.checked) if (this.clock - at > ICAO_TTL_MS) this.checked.delete(k)
    return gone
  }

  /** Folds one accepted message into its aircraft. */
  update(m: ModeSMessage, signalDb: number): Aircraft {
    const now = this.clock
    if (m.reliable && (m.df === 17 || m.df === 11)) this.checked.set(m.icao, now)
    if (m.reliable && m.df === 18) this.checked.set(m.icao | NON_TRANSPONDER, now)

    let t = this.tracks.get(m.icao)
    if (!t) {
      t = {
        icao: m.icao,
        hex: m.icao.toString(16).padStart(6, '0'),
        messages: 0,
        firstSeen: now,
        lastSeen: now,
        signalDb,
        lastDf: m.df,
        disagreed: 0,
      }
      this.tracks.set(m.icao, t)
    }
    t.messages++
    t.lastSeen = now
    t.lastDf = m.df
    t.signalDb = t.messages === 1 ? signalDb : t.signalDb * 0.8 + signalDb * 0.2

    if (m.callsign) t.callsign = m.callsign
    if (m.category) t.category = m.category
    if (m.squawk) t.squawk = m.squawk
    if (m.altitudeFt !== undefined) {
      t.altitudeFt = m.altitudeFt
      t.altitudeGnss = m.altitudeGnss === true
    }
    if (m.onGround !== undefined) t.onGround = m.onGround
    if (m.groundSpeedKt !== undefined) t.groundSpeedKt = m.groundSpeedKt
    if (m.trackDeg !== undefined) t.trackDeg = m.trackDeg
    if (m.headingDeg !== undefined) t.headingDeg = m.headingDeg
    if (m.airspeedKt !== undefined) t.airspeedKt = m.airspeedKt
    if (m.verticalRateFpm !== undefined) t.verticalRateFpm = m.verticalRateFpm

    if (m.cpr && !m.cpr.surface) this.position(t, m.cpr.odd, m.cpr.lat, m.cpr.lon, now)
    return t
  }

  private inRange(p: LatLon): boolean {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90) return false
    return !this.receiver || distanceKm(this.receiver, p) <= MAX_RANGE_KM
  }

  private plausible(t: Track, p: LatLon, now: number): boolean {
    if (!this.inRange(p)) return false
    if (t.position && t.positionAt !== undefined) {
      const dt = Math.max(0, now - t.positionAt) / 1000
      if (dt < REF_MAX_AGE_MS / 1000 && distanceKm(t.position, p) > 2 + dt * MAX_SPEED_KMS) {
        return false
      }
    }
    return true
  }

  private position(t: Track, odd: boolean, lat: number, lon: number, now: number): void {
    const held: CprHeld = { lat, lon, at: now }
    if (odd) t.odd = held
    else t.even = held

    const other = odd ? t.even : t.odd
    if (other && now - other.at <= PAIR_MS) {
      const e = odd ? other : held
      const o = odd ? held : other
      const p = cprGlobal(e.lat, e.lon, o.lat, o.lon, odd)
      if (p && this.plausible(t, p, now)) {
        t.disagreed = 0
        this.place(t, p, now, 'global')
        return
      }
      // a held position that was itself wrong would reject every good pair
      // after it, so a third global fix in a row that disagrees replaces it.
      if (p && this.inRange(p) && ++t.disagreed >= 3) {
        t.disagreed = 0
        this.place(t, p, now, 'global')
        return
      }
    }

    if (t.position && t.positionAt !== undefined && now - t.positionAt <= REF_MAX_AGE_MS) {
      const p = cprLocal(lat, lon, odd, t.position)
      if (this.plausible(t, p, now)) this.place(t, p, now, 'aircraft')
      return
    }

    if (this.receiver) {
      const p = cprLocal(lat, lon, odd, this.receiver)
      if (distanceKm(this.receiver, p) <= LOCAL_RANGE_KM && this.plausible(t, p, now)) {
        this.place(t, p, now, 'receiver')
      }
    }
  }

  private place(t: Track, p: LatLon, now: number, by: Aircraft['positionBy']): void {
    t.position = p
    t.positionAt = now
    t.positionBy = by
  }
}

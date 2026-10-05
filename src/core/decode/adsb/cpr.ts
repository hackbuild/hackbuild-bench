/**
 * Compact position reporting. An aircraft sends its position as 17 bit
 * fractions of a latitude zone and a longitude zone, alternating between an
 * even grid of 60 zones and an odd grid of 59. One report alone fixes the
 * position only within a zone, so it needs either the other parity heard
 * shortly before (global decode) or a nearby reference point (local decode).
 *
 * Airborne only. Surface reports use quarter size zones and need a reference
 * within 45 nautical miles, which is left for a later pass.
 */

const NZ = 15
const CPR_MAX = 131072

export interface LatLon {
  lat: number
  lon: number
}

function mod(a: number, b: number): number {
  const r = a % b
  return r < 0 ? r + b : r
}

/** Number of longitude zones at a latitude, from the closed form in DO-260B. */
export function cprNL(lat: number): number {
  const a = Math.abs(lat)
  if (a === 0) return 59
  if (a === 87) return 2
  if (a > 87) return 1
  const t = 1 - Math.cos(Math.PI / (2 * NZ))
  const c = Math.cos((Math.PI / 180) * a)
  return Math.floor((2 * Math.PI) / Math.acos(1 - t / (c * c)))
}

/**
 * Global decode from one even and one odd report. `oddIsNewer` picks which
 * one the result is the position of. Null when the two straddle a change in
 * the number of longitude zones, which means they cannot be paired.
 */
export function cprGlobal(
  evenLat: number,
  evenLon: number,
  oddLat: number,
  oddLon: number,
  oddIsNewer: boolean,
): LatLon | null {
  const latE = evenLat / CPR_MAX
  const latO = oddLat / CPR_MAX
  const lonE = evenLon / CPR_MAX
  const lonO = oddLon / CPR_MAX

  const j = Math.floor(59 * latE - 60 * latO + 0.5)
  let rlatE = (360 / 60) * (mod(j, 60) + latE)
  let rlatO = (360 / 59) * (mod(j, 59) + latO)
  if (rlatE >= 270) rlatE -= 360
  if (rlatO >= 270) rlatO -= 360
  if (rlatE < -90 || rlatE > 90 || rlatO < -90 || rlatO > 90) return null

  const nlE = cprNL(rlatE)
  if (nlE !== cprNL(rlatO)) return null

  const lat = oddIsNewer ? rlatO : rlatE
  const nl = cprNL(lat)
  const ni = Math.max(1, nl - (oddIsNewer ? 1 : 0))
  const m = Math.floor(lonE * (nl - 1) - lonO * nl + 0.5)
  let lon = (360 / ni) * (mod(m, ni) + (oddIsNewer ? lonO : lonE))
  if (lon >= 180) lon -= 360
  return { lat, lon }
}

/** Local decode of one report against a reference within half a zone, about 180 nm. */
export function cprLocal(cprLat: number, cprLon: number, odd: boolean, ref: LatLon): LatLon {
  const fLat = cprLat / CPR_MAX
  const fLon = cprLon / CPR_MAX
  const dLat = 360 / (odd ? 59 : 60)
  const j = Math.floor(ref.lat / dLat) + Math.floor(0.5 + mod(ref.lat, dLat) / dLat - fLat)
  const lat = dLat * (j + fLat)
  const ni = cprNL(lat) - (odd ? 1 : 0)
  const dLon = ni > 0 ? 360 / ni : 360
  const m = Math.floor(ref.lon / dLon) + Math.floor(0.5 + mod(ref.lon, dLon) / dLon - fLon)
  let lon = dLon * (m + fLon)
  if (lon >= 180) lon -= 360
  if (lon < -180) lon += 360
  return { lat, lon }
}

/** Encodes a position as a CPR report, for synthetic traffic. */
export function cprEncode(pos: LatLon, odd: boolean): { lat: number; lon: number } {
  const dLat = 360 / (odd ? 59 : 60)
  const yz = Math.floor(CPR_MAX * (mod(pos.lat, dLat) / dLat) + 0.5)
  const rlat = dLat * (yz / CPR_MAX + Math.floor(pos.lat / dLat))
  const ni = cprNL(rlat) - (odd ? 1 : 0)
  const dLon = ni > 0 ? 360 / ni : 360
  const xz = Math.floor(CPR_MAX * (mod(pos.lon, dLon) / dLon) + 0.5)
  return { lat: yz & (CPR_MAX - 1), lon: xz & (CPR_MAX - 1) }
}

const EARTH_KM = 6371

export function distanceKm(a: LatLon, b: LatLon): number {
  const p1 = (a.lat * Math.PI) / 180
  const p2 = (b.lat * Math.PI) / 180
  const dp = p2 - p1
  const dl = ((b.lon - a.lon) * Math.PI) / 180
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Initial bearing from a to b, degrees clockwise from true north. */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const p1 = (a.lat * Math.PI) / 180
  const p2 = (b.lat * Math.PI) / 180
  const dl = ((b.lon - a.lon) * Math.PI) / 180
  const y = Math.sin(dl) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return mod((Math.atan2(y, x) * 180) / Math.PI, 360)
}

/** Moves a point a distance along a bearing, for synthetic traffic. */
export function destination(from: LatLon, bearing: number, km: number): LatLon {
  const d = km / EARTH_KM
  const b = (bearing * Math.PI) / 180
  const p1 = (from.lat * Math.PI) / 180
  const l1 = (from.lon * Math.PI) / 180
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b))
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2))
  return { lat: (p2 * 180) / Math.PI, lon: ((((l2 * 180) / Math.PI + 540) % 360) - 180) }
}

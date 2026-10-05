import { AZ_COUNTIES, EVENTS, ORIGINATORS, STATES, SUBDIVISIONS } from './tables'

/** ZCZC-ORG-EEE-PSSCCC-PSSCCC+TTTT-JJJHHMM-LLLLLLLL- */
export interface SameHeader {
  raw: string
  originator: string
  event: string
  /** PSSCCC codes, in the order sent. */
  locations: string[]
  /** How long the alert stays valid, in minutes. */
  purgeMinutes: number
  /** Day of the year, 1 to 366, UTC. Test generators send 0. */
  issueDay: number
  issueHour: number
  issueMinute: number
  /** The sending station's eight character id, trimmed. */
  station: string
}

const PATTERN =
  /^ZCZC-([A-Z]{3})-([A-Z0-9]{3})((?:-[0-9]{6})+)\+([0-9]{4})-([0-9]{3})([0-9]{2})([0-9]{2})-([^-]{1,8})-$/

export function parseSame(raw: string): SameHeader | null {
  const m = PATTERN.exec(raw)
  if (!m) return null
  const purge = m[4]
  const hh = Number(m[6])
  const mm = Number(m[7])
  const day = Number(m[5])
  if (hh > 23 || mm > 59 || day > 366) return null
  return {
    raw,
    originator: m[1],
    event: m[2],
    locations: m[3].slice(1).split('-'),
    purgeMinutes: Number(purge.slice(0, 2)) * 60 + Number(purge.slice(2)),
    issueDay: day,
    issueHour: hh,
    issueMinute: mm,
    station: m[8].trim(),
  }
}

export function eventName(code: string): string {
  return EVENTS[code] ?? `event ${code.toLowerCase()}`
}

export function originatorName(code: string): string {
  return ORIGINATORS[code] ?? code.toLowerCase()
}

/** PSSCCC in words, or the raw code where the county is not in the table. */
export function locationName(code: string): string {
  const part = SUBDIVISIONS[Number(code[0])] ?? ''
  const ss = code.slice(1, 3)
  const ccc = code.slice(3)
  if (code === '000000') return 'the whole united states'
  const state = STATES[ss]
  if (!state) return `fips ${code}`
  if (ccc === '000') return `all of ${state[1]}`
  const county = ss === '04' ? AZ_COUNTIES[ccc] : undefined
  const where = county ? `${county} county ${state[0]}` : `county ${ss}${ccc} ${state[0]}`
  return part ? `${part} ${where}` : where
}

/** "required weekly test, maricopa county az, from KEC94" */
export function describeSame(h: SameHeader, maxPlaces = 4): string {
  const places = h.locations.map(locationName)
  const shown = places.slice(0, maxPlaces).join(' and ')
  const more = places.length > maxPlaces ? ` and ${places.length - maxPlaces} more` : ''
  return `${eventName(h.event)}, ${shown}${more}, from ${h.station}`
}

/** The issue time as a UTC instant, in the year of `near`. */
export function issuedAt(h: SameHeader, near: Date): Date {
  const at = (year: number) =>
    Date.UTC(year, 0, 1) + (h.issueDay - 1) * 86_400_000 + h.issueHour * 3_600_000 + h.issueMinute * 60_000
  const year = near.getUTCFullYear()
  const t = at(year)
  // a header from late december heard on the first of january belongs to the year before.
  return new Date(t - near.getTime() > 180 * 86_400_000 ? at(year - 1) : t)
}

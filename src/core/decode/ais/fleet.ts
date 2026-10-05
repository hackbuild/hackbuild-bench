/**
 * What the bench knows about each station, merged across message types.
 *
 * A class A ship sends its position every few seconds and its name every six
 * minutes, a class B unit splits its name and its call sign over the two
 * halves of a type 24, so a row fills in as the messages arrive.
 */

import type { AisMessage } from './message'
import type { AisChannelId } from './receiver'

export type StationKind = 'class a' | 'class b' | 'base station' | 'aid to navigation' | 'other'

export interface Vessel {
  mmsi: number
  kind: StationKind
  name?: string
  callsign?: string
  shipType?: number
  destination?: string
  lat?: number
  lon?: number
  sog?: number
  cog?: number
  heading?: number
  status?: string
  /** Wall clock ms of the last message of any kind. */
  lastSeen: number
  /** Wall clock ms of the last position. */
  positionAt?: number
  messages: number
  channels: AisChannelId[]
}

function kindOf(type: number): StationKind {
  if (type >= 1 && type <= 3) return 'class a'
  if (type === 5) return 'class a'
  if (type === 18 || type === 19 || type === 24) return 'class b'
  if (type === 4 || type === 11) return 'base station'
  if (type === 21) return 'aid to navigation'
  return 'other'
}

export class Fleet {
  private readonly byMmsi = new Map<number, Vessel>()

  get size(): number {
    return this.byMmsi.size
  }

  clear(): void {
    this.byMmsi.clear()
  }

  /** Folds one message in and returns the station it belongs to. */
  update(m: AisMessage, channel: AisChannelId, at: number): Vessel {
    let v = this.byMmsi.get(m.mmsi)
    if (!v) {
      v = { mmsi: m.mmsi, kind: kindOf(m.type), lastSeen: at, messages: 0, channels: [] }
      this.byMmsi.set(m.mmsi, v)
    }
    const kind = kindOf(m.type)
    if (kind !== 'other' && v.kind === 'other') v.kind = kind
    v.messages++
    v.lastSeen = at
    if (!v.channels.includes(channel)) v.channels = [...v.channels, channel].sort()
    if (m.name) v.name = m.name
    if (m.callsign) v.callsign = m.callsign
    if (m.shipType) v.shipType = m.shipType
    if (m.destination !== undefined && m.type === 5) v.destination = m.destination
    if (m.status) v.status = m.status
    if (m.lat !== undefined && m.lon !== undefined) {
      v.lat = m.lat
      v.lon = m.lon
      v.positionAt = at
      v.sog = m.sog
      v.cog = m.cog
      v.heading = m.heading
    }
    return v
  }

  /** Every station, most recently heard first. */
  list(): Vessel[] {
    return [...this.byMmsi.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** Drops stations not heard for `ms`. */
  prune(now: number, ms: number): void {
    for (const [k, v] of this.byMmsi) if (now - v.lastSeen > ms) this.byMmsi.delete(k)
  }
}

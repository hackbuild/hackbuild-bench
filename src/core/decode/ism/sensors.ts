/**
 * The sensors heard so far, one entry each, with their latest values.
 *
 * Sensors repeat a frame two to twelve times per transmission. A copy with
 * the same fields inside REPEAT_MS counts as the same transmission, so the
 * count is transmissions heard and each one publishes its readings once.
 * Sensors that alternate message types, such as the Acurite 5-in-1, have the
 * fields of each type merged into one entry.
 */

import type { IsmDecoded } from './decoder'
import { readingsOf, sensorKey } from './readings'
import type { SensorReading } from './readings'
import type { FieldValue } from './types'

const REPEAT_MS = 2000
/** A sensor unheard this long is dropped. */
export const SENSOR_AGE_OUT_MS = 30 * 60_000
/** Past this many sensors the one heard longest ago is dropped. */
export const MAX_SENSORS = 500

export interface SensorEntry {
  key: string
  model: string
  protocol: string
  id: FieldValue | undefined
  channel: FieldValue | undefined
  fields: Record<string, FieldValue>
  readings: Record<string, SensorReading>
  firstSeen: number
  lastSeen: number
  /** Transmissions heard, repeats folded. */
  count: number
  rssiDb: number
  snrDb: number
}

export interface Ingested {
  entry: SensorEntry
  /** False when this was a repeat of the transmission just counted. */
  fresh: boolean
  readings: SensorReading[]
}

export class SensorTable {
  private entries = new Map<string, SensorEntry>()
  private lastFrame = new Map<string, { sig: string; at: number }>()

  ingest(m: IsmDecoded, now: number): Ingested {
    const key = sensorKey(m.model, m.fields)
    const sig = JSON.stringify(m.fields)
    const prev = this.lastFrame.get(key)
    const fresh = !prev || prev.sig !== sig || now - prev.at > REPEAT_MS
    this.lastFrame.set(key, { sig, at: now })

    let e = this.entries.get(key)
    if (!e) {
      e = {
        key,
        model: m.model,
        protocol: m.protocol,
        id: m.fields.id,
        channel: m.fields.channel,
        fields: {},
        readings: {},
        firstSeen: now,
        lastSeen: now,
        count: 0,
        rssiDb: m.rssiDb,
        snrDb: m.snrDb,
      }
      this.entries.set(key, e)
    }
    const readings = readingsOf(m.fields)
    Object.assign(e.fields, m.fields)
    for (const r of readings) e.readings[r.key] = r
    e.lastSeen = now
    e.rssiDb = m.rssiDb
    e.snrDb = m.snrDb
    if (fresh) e.count++
    this.prune(now)
    return { entry: e, fresh, readings }
  }

  /** Drops sensors unheard for SENSOR_AGE_OUT_MS, then the oldest past MAX_SENSORS. */
  prune(now: number): void {
    for (const [k, e] of this.entries) {
      if (now - e.lastSeen > SENSOR_AGE_OUT_MS) this.drop(k)
    }
    if (this.entries.size <= MAX_SENSORS) return
    const oldest = [...this.entries.values()].sort((a, b) => a.lastSeen - b.lastSeen)
    for (const e of oldest.slice(0, this.entries.size - MAX_SENSORS)) this.drop(e.key)
  }

  private drop(key: string): void {
    this.entries.delete(key)
    this.lastFrame.delete(key)
  }

  list(): SensorEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
    this.lastFrame.clear()
  }
}

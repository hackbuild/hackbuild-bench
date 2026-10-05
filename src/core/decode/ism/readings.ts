/**
 * Sensor values in one set of units, whatever the protocol sent.
 *
 * Field names follow rtl_433's conventions, where the unit is the suffix.
 * Each known field maps to a reading with a fixed name, so a table or an
 * automation can read `temperature` without knowing which sensor sent it.
 */

import type { FieldValue } from './types'

export interface SensorReading {
  /** Stable key: temperature, humidity, wind, gust, wind_dir, rain, pressure, battery, uvi, light. */
  key: string
  value: number
  unit: string
  /** The rtl_433 field it came from. */
  field: string
}

interface Rule {
  key: string
  unit: string
  convert: (v: number) => number
}

const RULES: Record<string, Rule> = {
  temperature_C: { key: 'temperature', unit: 'C', convert: (v) => v },
  temperature_F: { key: 'temperature', unit: 'C', convert: (v) => ((v - 32) * 5) / 9 },
  humidity: { key: 'humidity', unit: '%', convert: (v) => v },
  wind_avg_km_h: { key: 'wind', unit: 'km/h', convert: (v) => v },
  wind_avg_m_s: { key: 'wind', unit: 'km/h', convert: (v) => v * 3.6 },
  wind_avg_mi_h: { key: 'wind', unit: 'km/h', convert: (v) => v * 1.609344 },
  wind_max_km_h: { key: 'gust', unit: 'km/h', convert: (v) => v },
  wind_max_m_s: { key: 'gust', unit: 'km/h', convert: (v) => v * 3.6 },
  wind_dir_deg: { key: 'wind_dir', unit: 'deg', convert: (v) => v },
  rain_mm: { key: 'rain', unit: 'mm', convert: (v) => v },
  rain_in: { key: 'rain', unit: 'mm', convert: (v) => v * 25.4 },
  pressure_hPa: { key: 'pressure', unit: 'hPa', convert: (v) => v },
  pressure_kPa: { key: 'pressure', unit: 'kPa', convert: (v) => v },
  pressure_PSI: { key: 'pressure', unit: 'kPa', convert: (v) => v * 6.894757 },
  battery_ok: { key: 'battery', unit: 'ok', convert: (v) => v },
  uvi: { key: 'uvi', unit: '', convert: (v) => v },
  light_lux: { key: 'light', unit: 'lux', convert: (v) => v },
}

export function readingsOf(fields: Record<string, FieldValue>): SensorReading[] {
  const out: SensorReading[] = []
  for (const [field, raw] of Object.entries(fields)) {
    const rule = RULES[field]
    if (!rule || typeof raw !== 'number' || !Number.isFinite(raw)) continue
    out.push({ key: rule.key, value: rule.convert(raw), unit: rule.unit, field })
  }
  return out
}

export function cToF(c: number): number {
  return (c * 9) / 5 + 32
}

/** What a sensor is called in the table: model, id, and channel when it has one. */
export function sensorKey(model: string, fields: Record<string, FieldValue>): string {
  const id = fields.id ?? ''
  const ch = fields.channel
  return ch === undefined ? `${model}/${id}` : `${model}/${id}/${ch}`
}

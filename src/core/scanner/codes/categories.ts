/**
 * How the bench groups what a call is about, from the codes heard in it.
 *
 * These are the bench's own buckets, not anything a department publishes.
 * They sort a busy screen so the serious traffic stands out.
 */
export type CodeCategory =
  | 'officer emergency'
  | 'violent'
  | 'fire and hazard'
  | 'medical'
  | 'mental health'
  | 'traffic'
  | 'property'
  | 'drugs and vice'
  | 'welfare'
  | 'suspicious'
  | 'disturbance'
  | 'warrants and custody'
  | 'public works'
  | 'status'
  | 'other'

/** How loud a category should read, high first, for sorting and colour. */
export const CATEGORY_PRIORITY: Record<CodeCategory, number> = {
  'officer emergency': 100,
  violent: 90,
  'fire and hazard': 80,
  medical: 70,
  'mental health': 60,
  traffic: 50,
  property: 45,
  'drugs and vice': 44,
  welfare: 43,
  suspicious: 42,
  disturbance: 40,
  'warrants and custody': 35,
  'public works': 20,
  status: 10,
  other: 5,
}

/** The lit colour a category draws in, for the void scope and the list. */
export const CATEGORY_COLOR: Record<CodeCategory, string> = {
  'officer emergency': 'var(--hb-lit-err)',
  violent: 'var(--hb-lit-err)',
  'fire and hazard': 'var(--hb-lit-warn)',
  medical: 'var(--hb-lit-warn)',
  'mental health': 'var(--hb-lit-warn)',
  traffic: 'var(--hb-lit-info)',
  property: 'var(--hb-lit-info)',
  'drugs and vice': 'var(--hb-lit-info)',
  welfare: 'var(--hb-lit-info)',
  suspicious: 'var(--hb-lit-info)',
  disturbance: 'var(--hb-lit-info)',
  'warrants and custody': 'var(--hb-lit-info)',
  'public works': 'var(--hb-lit-dim)',
  status: 'var(--hb-lit-dim)',
  other: 'var(--hb-lit-dim)',
}

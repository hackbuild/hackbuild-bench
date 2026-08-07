import { IdenTable, resolveChannel } from './iden'
import { parseTsbk } from './tsbk'
import type { Grant, SiteStatus } from './tsbk'
import type { RadioSystem, TalkgroupEntry } from '../systems'

/**
 * Trunk following at the metadata level.
 *
 * Feed it decoded TSBK octets from a control channel and it maintains the
 * identifier table, resolves grants to frequencies, and reports live calls:
 * which talkgroup is active, on what frequency, from which radio, and whether
 * it is followable inside the current tuned window.
 *
 * Turning IQ into TSBK octets needs a C4FM demodulator, symbol recovery, a
 * trellis decode, and a CRC, which the browser build does not do. So this runs
 * against a control channel decoder when one exists, and against the demo
 * generator otherwise. The parsing, the frequency math, and the call logic are
 * the same either way.
 */

export interface TrunkCall {
  id: string
  talkgroup: number
  name: string
  service: string
  agency?: string
  hz: number
  slot: number
  source?: number
  emergency: boolean
  encrypted: boolean
  /** True when the frequency sits inside the tuned window, so audio is reachable. */
  followable: boolean
  startedAt: number
  endedAt: number | null
}

export interface TrunkHooks {
  onCall(call: TrunkCall): void
  onCallEnd(call: TrunkCall): void
  onStatus(status: SiteStatus): void
  onIdent(count: number): void
}

/** ±950 kHz of a 2.0 MHz usable window at 2.4 Msps, minus channel guard. */
const USABLE_HALF_HZ = 943_750

export class TrunkFollower {
  private table = new IdenTable()
  private system: RadioSystem
  private tgIndex = new Map<number, TalkgroupEntry>()
  private hooks: TrunkHooks
  private active = new Map<number, TrunkCall>()
  private counter = 0
  private centerHz = 0
  private calls: TrunkCall[] = []

  constructor(system: RadioSystem, hooks: TrunkHooks) {
    this.system = system
    this.hooks = hooks
    for (const tg of system.talkgroups) this.tgIndex.set(tg.id, tg)
  }

  /** The frequency the receiver is parked on, used for the window test. */
  setCenter(hz: number): void {
    this.centerHz = hz
  }

  get callLog(): TrunkCall[] {
    return this.calls
  }

  get identCount(): number {
    return this.table.size
  }

  /** A site change reuses identifiers, so the table is flushed. */
  flushIdentifiers(): void {
    this.table.clear()
  }

  /** Feed one decoded 12 octet TSBK. */
  feedTsbk(octets: Uint8Array): void {
    const r = parseTsbk(octets, this.table, this.system.nac)
    if (r.identUpdate) this.hooks.onIdent(this.table.size)
    if (r.status) this.hooks.onStatus(r.status)
    for (const grant of r.grants) this.applyGrant(grant)
  }

  private applyGrant(grant: Grant): void {
    if (grant.kind !== 'group' || grant.talkgroup === undefined) return
    const resolved = resolveChannel(this.table, grant.channel)
    if (!resolved) return // identifier not seen yet, drop rather than guess

    const existing = this.active.get(grant.talkgroup)
    if (existing) {
      existing.endedAt = null // refresh, the call is still up
      return
    }

    const tg = this.tgIndex.get(grant.talkgroup)
    const followable = Math.abs(resolved.hz - this.centerHz) <= USABLE_HALF_HZ && resolved.slot === 0

    const call: TrunkCall = {
      id: `tg-${++this.counter}`,
      talkgroup: grant.talkgroup,
      name: tg?.name ?? `talkgroup ${grant.talkgroup}`,
      service: tg?.service ?? 'other',
      agency: tg?.agency,
      hz: resolved.hz,
      slot: resolved.slot,
      source: grant.source,
      emergency: grant.emergency,
      encrypted: grant.encrypted || tg?.encrypted || false,
      followable,
      startedAt: Date.now(),
      endedAt: null,
    }
    this.active.set(grant.talkgroup, call)
    this.calls = [call, ...this.calls].slice(0, 300)
    this.hooks.onCall(call)
  }

  /** Age out calls that have not been refreshed by a grant update. */
  tick(hangMs = 3000): void {
    const now = Date.now()
    for (const [tg, call] of this.active) {
      if (call.endedAt === null) {
        call.endedAt = now // mark, cleared if a grant refreshes it
      } else if (now - call.endedAt > hangMs) {
        this.active.delete(tg)
        this.hooks.onCallEnd(call)
      }
    }
  }
}

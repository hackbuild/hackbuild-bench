import { IdenTable, resolveChannel } from './iden'
import { parseTsbk } from './tsbk'
import type { Grant, SiteStatus } from './tsbk'
import type { RadioSystem, TalkgroupEntry } from '../systems'

/**
 * Trunk following at the metadata level.
 *
 * Feed it decoded TSBK octets from a control channel and it maintains the
 * identifier table, resolves grants to frequencies, and reports live calls:
 * which talkgroup is active, on what frequency, and from which radio.
 *
 * `receiver.ts` turns IQ into those octets and `tsbk.ts` parses them, so this runs
 * against a live control channel when a radio is streaming, and against the
 * demo generator otherwise. The frequency math and the call logic are the same
 * either way. Voice stays out of reach, LDU frames carry IMBE and this build
 * has no vocoder.
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
  /** Phase 2 voice rides a TDMA channel with AMBE+2, which is not decoded here. */
  phase2: boolean
  startedAt: number
  endedAt: number | null
}

export interface TrunkHooks {
  onCall(call: TrunkCall): void
  onCallEnd(call: TrunkCall): void
  onStatus(status: SiteStatus): void
  onIdent(count: number): void
}

export class TrunkFollower {
  private table = new IdenTable()
  private system: RadioSystem
  private tgIndex = new Map<number, TalkgroupEntry>()
  private hooks: TrunkHooks
  private active = new Map<number, TrunkCall>()
  private counter = 0
  private calls: TrunkCall[] = []

  constructor(system: RadioSystem, hooks: TrunkHooks) {
    this.system = system
    this.hooks = hooks
    for (const tg of system.talkgroups) this.tgIndex.set(tg.id, tg)
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
      phase2: resolved.tdma,
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

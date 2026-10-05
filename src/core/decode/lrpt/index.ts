/**
 * Meteor LRPT, the digital picture downlink the Meteor-M satellites send on
 * 137 MHz, from baseband IQ to MSU-MR image strips.
 *
 * Two link setups exist. Meteor-M N2-3 and N2-4 send OQPSK at 72 ksym/s
 * with NRZ-M differential coding. The original Meteor-M N2 sent plain QPSK
 * at 72 ksym/s, which still turns up in archived recordings. The 80 ksym/s
 * interleaved mode is not decoded here.
 *
 * Either way the decoder needs 144 thousand soft bits a second into the
 * Viterbi decoder, and a pass overhead to give it any.
 */

import { LrptDemod } from './demod'
import type { DemodStats } from './demod'
import { LrptFramer } from './framer'
import type { Frame, FramerStats } from './framer'
import { IMAGE_VCID, PacketDemux, parseVcdu } from './packets'
import type { SpacePacket } from './packets'
import { ScanPlacer, TELEMETRY_APID, decodeStrip } from './msumr'
import type { PlacedStrip } from './msumr'

export { MSUMR_WIDTH, STRIP_WIDTH } from './msumr'
export type { PlacedStrip } from './msumr'
export type { SpacePacket } from './packets'
export type { DemodStats } from './demod'
export type { FramerStats, Frame } from './framer'

export type LrptLink = 'm2x' | 'm2'

export interface LrptLinkSpec {
  id: LrptLink
  label: string
  symbolRate: number
  oqpsk: boolean
  nrzm: boolean
}

export const LRPT_LINKS: Record<LrptLink, LrptLinkSpec> = {
  m2x: { id: 'm2x', label: 'oqpsk 72k, nrz-m (m2-3, m2-4)', symbolRate: 72000, oqpsk: true, nrzm: true },
  m2: { id: 'm2', label: 'qpsk 72k (original m2, archives)', symbolRate: 72000, oqpsk: false, nrzm: false },
}

export interface LrptOptions {
  link: LrptLink
  /** Where the signal sits in the IQ, Hz from its centre. */
  offsetHz?: number
}

export interface LrptStats {
  demod: DemodStats
  framer: FramerStats
  packets: number
  strips: number
  /** Image APIDs seen so far. */
  apids: number[]
  /** Scans placed in the current pass, 8 rows each. */
  scans: number
  /** The pass the current picture belongs to, from 0. */
  pass: number
  /** Spacecraft id from the last good frame, -1 before one. */
  scid: number
}

export class LrptDecoder {
  onStrip: ((s: PlacedStrip) => void) | null = null
  onPacket: ((p: SpacePacket) => void) | null = null
  onFrame: ((f: Frame) => void) | null = null

  private demod: LrptDemod
  private framer: LrptFramer
  private demux = new PacketDemux()
  private placer = new ScanPlacer()
  private packets = 0
  private strips = 0
  private apids = new Set<number>()
  private scans = 0
  private pass = 0
  private scid = -1
  readonly link: LrptLinkSpec

  constructor(opts: LrptOptions) {
    this.link = LRPT_LINKS[opts.link]
    this.demod = new LrptDemod({
      symbolRate: this.link.symbolRate,
      oqpsk: this.link.oqpsk,
      offsetHz: opts.offsetHz ?? 0,
    })
    this.framer = new LrptFramer({ oqpsk: this.link.oqpsk, nrzm: this.link.nrzm })
  }

  get stats(): LrptStats {
    return {
      demod: this.demod.stats,
      framer: this.framer.stats,
      packets: this.packets,
      strips: this.strips,
      apids: [...this.apids].sort((a, b) => a - b),
      scans: this.scans,
      pass: this.pass,
      scid: this.scid,
    }
  }

  setOffset(hz: number): void {
    this.demod.setOffset(hz)
  }

  reset(): void {
    this.demod.reset()
    this.framer.reset()
    this.demux.reset()
    this.placer.reset()
    this.packets = 0
    this.strips = 0
    this.apids.clear()
    this.scans = 0
    this.pass = 0
    this.scid = -1
  }

  /** Interleaved float IQ in about -1 to 1. */
  feedIq(iq: Float32Array, sampleRate: number): void {
    this.feedSoft(this.demod.process(iq, sampleRate))
  }

  /** Soft symbol pairs, I then Q, positive for a one. */
  feedSoft(soft: Int8Array): void {
    for (const f of this.framer.push(soft)) this.frame(f)
  }

  /** Places anything still waiting on the scan phase, at the end of a recording. */
  finish(): void {
    for (const s of this.placer.drain()) this.emit(s)
  }

  private frame(f: Frame): void {
    this.onFrame?.(f)
    if (!f.ok) return
    const v = parseVcdu(f.cadu)
    this.scid = v.scid
    if (v.vcid !== IMAGE_VCID) return
    for (const p of this.demux.push(f.cadu, v.counter)) {
      this.packets++
      this.onPacket?.(p)
      if (p.apid === TELEMETRY_APID) {
        for (const s of this.placer.telemetry(p.seq)) this.emit(s)
        continue
      }
      const strip = decodeStrip(p.bytes)
      if (!strip) continue
      for (const s of this.placer.add(strip)) this.emit(s)
    }
  }

  private emit(s: PlacedStrip): void {
    this.strips++
    this.apids.add(s.apid)
    if (s.pass !== this.pass) {
      this.pass = s.pass
      this.scans = 0
    }
    this.scans = Math.max(this.scans, s.scan + 1)
    this.onStrip?.(s)
  }
}

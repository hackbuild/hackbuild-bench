import { BlockSync } from './blocks'
import type { RdsGroup } from './blocks'
import { RdsDemod } from './demod'
import { FmMpx } from './frontend'
import { RdsStation } from './station'
import type { RdsEvent, RdsSnapshot } from './station'

export type { RdsGroup } from './blocks'
export type { RdsClock, RdsEvent, RdsSnapshot } from './station'
export { callSignFromPi, PTY_RBDS, PTY_RDS } from './tables'

export interface RdsStatus {
  synced: boolean
  /** Share of recent blocks that failed their check, 0 to 1. */
  blockErrorRate: number
  /** How clearly the biphase pairing stands out, 0 to 1. Near zero is no RDS. */
  quality: number
  /** Multiplex rate the decoder settled on, in Hz. */
  mpxRate: number
}

export interface RdsDecoderOptions {
  /** Longest error burst corrected per block, 1 to 5. */
  maxBurst?: number
  /** North American names and call signs. */
  rbds?: boolean
}

/**
 * IQ or multiplex in, station data out.
 *
 * Feed IQ at the radio's rate with the listening offset, or a multiplex that
 * some other demodulator produced. Both end in the same subcarrier decoder.
 */
export class RdsDecoder {
  private front = new FmMpx()
  private demod: RdsDemod | null = null
  private readonly sync: BlockSync
  readonly station = new RdsStation()
  private iqRate = 0
  private iqOffset = 0

  onEvent: (e: RdsEvent) => void = () => {}
  onGroup: (g: RdsGroup) => void = () => {}

  constructor(opts: RdsDecoderOptions = {}) {
    this.sync = new BlockSync({ maxBurst: opts.maxBurst ?? 5 })
    this.station.rbds = opts.rbds ?? true
    this.sync.onGroup = (g) => {
      this.onGroup(g)
      this.station.push(g)
    }
    this.station.onEvent = (e) => this.onEvent(e)
  }

  /** Clears everything learned, for a retune. */
  reset(): void {
    this.sync.reset()
    this.station.reset()
    this.demod = null
    this.front = new FmMpx()
    this.iqRate = 0
  }

  feedIq(iq: Float32Array, sampleRate: number, offsetHz: number): void {
    if (sampleRate !== this.iqRate || offsetHz !== this.iqOffset) {
      if (sampleRate !== this.iqRate) this.front = new FmMpx()
      this.iqRate = sampleRate
      this.iqOffset = offsetHz
      this.front.configure(sampleRate, offsetHz)
    }
    this.feedMpx(this.front.process(iq), this.front.rate)
  }

  feedMpx(mpx: Float32Array, sampleRate: number): void {
    if (!this.demod || this.demod.inputRate !== sampleRate) {
      this.demod = new RdsDemod(sampleRate)
      this.demod.onBit = (bit) => this.sync.push(bit)
    }
    this.demod.process(mpx)
  }

  get status(): RdsStatus {
    return {
      synced: this.sync.isSynced,
      blockErrorRate: this.sync.blockErrorRate,
      quality: this.demod?.state.quality ?? 0,
      mpxRate: this.demod?.inputRate ?? 0,
    }
  }

  snapshot(): RdsSnapshot {
    return this.station.snapshot()
  }
}

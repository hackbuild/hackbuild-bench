/**
 * P25 channel identifier tables and the channel-to-frequency math.
 *
 * A trunking grant carries a 16 bit channel number, not a frequency. The top
 * 4 bits pick an identifier, the low 12 are a channel index into that
 * identifier's band. The identifier tables arrive on the control channel in
 * IDEN_UP messages, cyclically every few seconds. Without the matching
 * identifier a grant cannot be turned into a frequency, so an unknown one is
 * dropped rather than guessed.
 *
 * The math and the worked examples here follow the op25 implementation.
 */

export interface IdenEntry {
  iden: number
  /** Band base frequency in Hz. */
  baseHz: number
  /** Channel spacing in Hz. */
  spacingHz: number
  /** Transmit offset in Hz, signed. Not needed to receive, kept for display. */
  offsetHz: number
  bandwidthHz: number
  /** Carriers per channel slot. 1 for FDMA, 2 for two-slot TDMA. */
  slotsPerCarrier: number
}

export class IdenTable {
  private table = new Map<number, IdenEntry>()

  /** IDEN_UP (0x3D), the 700 and 800 MHz form. */
  setStandard(iden: number, baseUnit: number, spacing: number, bwUnit: number, offsetSign: number, offsetMag: number): void {
    // base is in units of 5 Hz, spacing in 125 Hz, offset magnitude in 250 kHz.
    this.table.set(iden, {
      iden,
      baseHz: baseUnit * 5,
      spacingHz: spacing * 125,
      offsetHz: (offsetSign ? -1 : 1) * offsetMag * 250_000,
      bandwidthHz: bwUnit * 125,
      slotsPerCarrier: 1,
    })
  }

  /** IDEN_UP_VU (0x34), the VHF and UHF form. */
  setVu(iden: number, baseUnit: number, spacing: number, offsetSign: number, offsetMag: number): void {
    // base in 5 Hz, spacing in 125 Hz, offset magnitude in units of 250 kHz.
    this.table.set(iden, {
      iden,
      baseHz: baseUnit * 5,
      spacingHz: spacing * 125,
      offsetHz: (offsetSign ? -1 : 1) * offsetMag * 250_000,
      bandwidthHz: 12_500,
      slotsPerCarrier: 1,
    })
  }

  /** IDEN_UP_TDMA (0x33), the Phase 2 form. */
  setTdma(iden: number, baseUnit: number, spacing: number, offsetSign: number, offsetMag: number, channelType: number): void {
    // channelType 3 and 4 are the two-slot TDMA types.
    const slots = channelType === 3 || channelType === 4 ? 2 : 1
    this.table.set(iden, {
      iden,
      baseHz: baseUnit * 5,
      spacingHz: spacing * 125,
      offsetHz: (offsetSign ? -1 : 1) * offsetMag * 250_000,
      bandwidthHz: 12_500,
      slotsPerCarrier: slots,
    })
  }

  has(iden: number): boolean {
    return this.table.has(iden)
  }

  get(iden: number): IdenEntry | undefined {
    return this.table.get(iden)
  }

  /** Sites reuse identifiers with different bands, so flush on a site change. */
  clear(): void {
    this.table.clear()
  }

  get size(): number {
    return this.table.size
  }
}

export interface ResolvedChannel {
  hz: number
  /** Which TDMA slot, or 0 for FDMA. */
  slot: number
}

/**
 * Turns a 16 bit trunking channel into a receive frequency and slot.
 *
 * Returns null when the identifier is unknown or the result is outside a sane
 * range, because acting on a bad grant sends the receiver to a wrong frequency
 * and poisons everything after it.
 */
export function resolveChannel(table: IdenTable, channel: number): ResolvedChannel | null {
  const iden = (channel >> 12) & 0xf
  const chan = channel & 0xfff
  const entry = table.get(iden)
  if (!entry) return null

  if (entry.slotsPerCarrier === 2) {
    const carrier = Math.floor(chan / 2)
    const slot = chan % 2
    const hz = entry.baseHz + carrier * entry.spacingHz
    return sane(hz) ? { hz, slot } : null
  }

  const hz = entry.baseHz + chan * entry.spacingHz
  return sane(hz) ? { hz, slot: 0 } : null
}

function sane(hz: number): boolean {
  return hz >= 25e6 && hz <= 1300e6
}

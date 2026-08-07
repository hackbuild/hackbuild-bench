import { IdenTable } from './iden'

/**
 * P25 trunking signaling block parsing.
 *
 * A TSBK is 12 octets after error correction: an opcode octet, a manufacturer
 * id, then eight payload octets and a two octet CRC. The control channel
 * carries a stream of these. The ones worth acting on are the voice grants,
 * which say a talkgroup moved to a channel, and the identifier updates, which
 * define how a channel number becomes a frequency.
 *
 * The layouts and opcode numbers follow op25. The manufacturer id must be
 * checked before the payload, because Motorola reuses low opcodes for patch
 * management that would otherwise look like grants and send the receiver to a
 * wrong frequency.
 *
 * This module parses. Symbol recovery and the trellis and CRC that produce the
 * 12 octets are the receiver's job and are not attempted in the browser build.
 */

export const OPCODE = {
  GRP_VCH_GRANT: 0x00,
  GRP_VCH_GRANT_UPDT: 0x02,
  GRP_VCH_GRANT_UPDT_EXP: 0x03,
  UU_VCH_GRANT: 0x04,
  UU_VCH_GRANT_UPDT: 0x06,
  RFSS_STS_BCST: 0x3a,
  NET_STS_BCST: 0x3b,
  ADJ_STS_BCST: 0x3c,
  IDEN_UP: 0x3d,
  IDEN_UP_VU: 0x34,
  IDEN_UP_TDMA: 0x33,
} as const

export const MFID_MOTOROLA = 0x90

export interface Grant {
  kind: 'group' | 'unit'
  channel: number
  /** Talkgroup for a group call, or the destination radio for a unit call. */
  talkgroup?: number
  target?: number
  source?: number
  emergency: boolean
  encrypted: boolean
}

export interface SiteStatus {
  rfss?: number
  site?: number
  wacn?: number
  sysId?: number
  nac?: number
}

export interface TsbkResult {
  opcode: number
  mfid: number
  grants: Grant[]
  identUpdate: boolean
  status?: SiteStatus
}

/**
 * Parse one 12 octet TSBK. Feeds any identifier updates straight into the
 * table, and returns the grants worth following.
 */
export function parseTsbk(octets: Uint8Array, table: IdenTable, nac?: number): TsbkResult {
  const opcode = octets[0] & 0x3f
  const mfid = octets[1]
  const p = octets.subarray(2) // payload octets, p[0..7]
  const out: TsbkResult = { opcode, mfid, grants: [], identUpdate: false }

  // motorola reuses opcode 0x00 for patch group add, which is not a grant.
  if (opcode === OPCODE.GRP_VCH_GRANT && mfid === MFID_MOTOROLA) {
    return out
  }

  switch (opcode) {
    case OPCODE.GRP_VCH_GRANT: {
      const opts = p[0]
      out.grants.push({
        kind: 'group',
        channel: (p[1] << 8) | p[2],
        talkgroup: (p[3] << 8) | p[4],
        source: (p[5] << 16) | (p[6] << 8) | p[7],
        emergency: (opts & 0x80) !== 0,
        encrypted: (opts & 0x40) !== 0,
      })
      break
    }
    case OPCODE.GRP_VCH_GRANT_UPDT: {
      // two grants, no source. a padding system repeats the same channel.
      const ch1 = (p[0] << 8) | p[1]
      const ga1 = (p[2] << 8) | p[3]
      const ch2 = (p[4] << 8) | p[5]
      const ga2 = (p[6] << 8) | p[7]
      out.grants.push({ kind: 'group', channel: ch1, talkgroup: ga1, emergency: false, encrypted: false })
      if (ch2 !== ch1 || ga2 !== ga1) {
        out.grants.push({ kind: 'group', channel: ch2, talkgroup: ga2, emergency: false, encrypted: false })
      }
      break
    }
    case OPCODE.GRP_VCH_GRANT_UPDT_EXP: {
      const opts = p[0]
      // octet 3 reserved, channel-t is the downlink to tune.
      out.grants.push({
        kind: 'group',
        channel: (p[2] << 8) | p[3],
        talkgroup: (p[6] << 8) | p[7],
        emergency: (opts & 0x80) !== 0,
        encrypted: (opts & 0x40) !== 0,
      })
      break
    }
    case OPCODE.UU_VCH_GRANT:
    case OPCODE.UU_VCH_GRANT_UPDT: {
      out.grants.push({
        kind: 'unit',
        channel: (p[0] << 8) | p[1],
        target: (p[2] << 16) | (p[3] << 8) | p[4],
        source: (p[5] << 16) | (p[6] << 8) | p[7],
        emergency: false,
        encrypted: false,
      })
      break
    }
    case OPCODE.IDEN_UP: {
      // p[0]: iden(4) | bw high; the op25 packing across p[0..7].
      const iden = (p[0] >> 4) & 0xf
      const bwvu = ((p[0] & 0xf) << 5) | ((p[1] >> 3) & 0x1f)
      const offsetSign = (p[1] >> 2) & 0x1
      const offsetMag = ((p[1] & 0x3) << 12) | (p[2] << 4) | ((p[3] >> 4) & 0xf)
      const spacing = ((p[3] & 0xf) << 6) | ((p[4] >> 2) & 0x3f)
      const base = ((p[4] & 0x3) << 30) | (p[5] << 22) | (p[6] << 14) | (p[7] << 6)
      table.setStandard(iden, base >>> 0, spacing, bwvu, offsetSign, offsetMag)
      out.identUpdate = true
      break
    }
    case OPCODE.IDEN_UP_VU: {
      const iden = (p[0] >> 4) & 0xf
      const bwvu = ((p[0] & 0xf) << 5) | ((p[1] >> 3) & 0x1f)
      const offsetSign = (p[1] >> 2) & 0x1
      const offsetMag = ((p[1] & 0x3) << 12) | (p[2] << 4) | ((p[3] >> 4) & 0xf)
      const spacing = ((p[3] & 0xf) << 6) | ((p[4] >> 2) & 0x3f)
      const base = ((p[4] & 0x3) << 30) | (p[5] << 22) | (p[6] << 14) | (p[7] << 6)
      // bandwidth field on the vu form is not used for tuning, spacing is.
      void bwvu
      table.setVu(iden, base >>> 0, spacing, offsetSign, offsetMag)
      out.identUpdate = true
      break
    }
    case OPCODE.IDEN_UP_TDMA: {
      const iden = (p[0] >> 4) & 0xf
      const channelType = p[0] & 0xf
      const offsetSign = (p[1] >> 6) & 0x1
      const offsetMag = ((p[1] & 0x3f) << 8) | p[2]
      const spacing = ((p[3] << 2) | ((p[4] >> 6) & 0x3)) & 0x3ff
      const base = (((p[4] & 0x3f) << 26) | (p[5] << 18) | (p[6] << 10) | (p[7] << 2)) >>> 0
      table.setTdma(iden, base, spacing, offsetSign, offsetMag, channelType)
      out.identUpdate = true
      break
    }
    case OPCODE.NET_STS_BCST: {
      // wacn 20 bits and system id 12 bits across the payload.
      const wacn = ((p[1] << 12) | (p[2] << 4) | ((p[3] >> 4) & 0xf)) & 0xfffff
      const sysId = (((p[3] & 0xf) << 8) | p[4]) & 0xfff
      out.status = { wacn, sysId, nac }
      break
    }
    case OPCODE.RFSS_STS_BCST: {
      const rfss = p[2]
      const site = p[3]
      out.status = { rfss, site, nac }
      break
    }
    default:
      break
  }

  return out
}

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
 * read before the payload, because Motorola gives the low opcodes their own
 * layouts for patch management, and reading one with the standard layout sends
 * the receiver to a wrong frequency.
 *
 * This module only parses. `c4fm.ts` produces the 12 octets and `trunk.ts`
 * follows the grants.
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
      if (mfid === MFID_MOTOROLA) {
        // mot_grg_cn_grant: one supergroup, and the channel sits an octet in.
        out.grants.push({
          kind: 'group',
          channel: (p[1] << 8) | p[2],
          talkgroup: (p[3] << 8) | p[4],
          source: (p[5] << 16) | (p[6] << 8) | p[7],
          emergency: false,
          encrypted: false,
        })
        break
      }
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
      if (mfid === MFID_MOTOROLA) {
        // mot_grg_cn_grant_updt: two supergroups, laid out like the plain
        // update rather than like the explicit form.
        const mch1 = (p[0] << 8) | p[1]
        const msg1 = (p[2] << 8) | p[3]
        const mch2 = (p[4] << 8) | p[5]
        const msg2 = (p[6] << 8) | p[7]
        out.grants.push({ kind: 'group', channel: mch1, talkgroup: msg1, emergency: false, encrypted: false })
        if (mch2 !== mch1 || msg2 !== msg1) {
          out.grants.push({ kind: 'group', channel: mch2, talkgroup: msg2, emergency: false, encrypted: false })
        }
        break
      }
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
      // 64 bit payload: iden 4, bandwidth 9, offset sign 1, offset magnitude 8,
      // spacing 10, base 32.
      const iden = (p[0] >> 4) & 0xf
      const bw = ((p[0] & 0xf) << 5) | ((p[1] >> 3) & 0x1f)
      const offsetSign = (p[1] >> 2) & 0x1
      const offsetMag = ((p[1] & 0x3) << 6) | ((p[2] >> 2) & 0x3f)
      const spacing = ((p[2] & 0x3) << 8) | p[3]
      const base = base32(p)
      table.setStandard(iden, base, spacing, bw, offsetSign, offsetMag)
      out.identUpdate = true
      break
    }
    case OPCODE.IDEN_UP_VU: {
      // 64 bit payload: iden 4, bandwidth or channel type 4, offset sign 1,
      // offset magnitude 13, spacing 10, base 32.
      const iden = (p[0] >> 4) & 0xf
      const offsetSign = (p[1] >> 7) & 0x1
      const offsetMag = ((p[1] & 0x7f) << 6) | ((p[2] >> 2) & 0x3f)
      const spacing = ((p[2] & 0x3) << 8) | p[3]
      table.setVu(iden, base32(p), spacing, offsetSign, offsetMag)
      out.identUpdate = true
      break
    }
    case OPCODE.IDEN_UP_TDMA: {
      const iden = (p[0] >> 4) & 0xf
      const channelType = p[0] & 0xf
      const offsetSign = (p[1] >> 7) & 0x1
      const offsetMag = ((p[1] & 0x7f) << 6) | ((p[2] >> 2) & 0x3f)
      const spacing = ((p[2] & 0x3) << 8) | p[3]
      table.setTdma(iden, base32(p), spacing, offsetSign, offsetMag, channelType)
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
      const sysId = ((p[1] & 0xf) << 8) | p[2]
      const rfss = p[3]
      const site = p[4]
      out.status = { rfss, site, sysId, nac }
      break
    }
    default:
      break
  }

  return out
}

/** Band base frequency in units of 5 Hz, the last four payload octets. */
function base32(p: Uint8Array): number {
  return ((p[4] << 24) | (p[5] << 16) | (p[6] << 8) | p[7]) >>> 0
}

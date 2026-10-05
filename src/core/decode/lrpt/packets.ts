/**
 * VCDU to CCSDS space packets, the way Meteor packs them.
 *
 * A CADU carries a 892 byte VCDU: a six byte primary header, a two byte
 * insert zone, a two byte M_PDU header with an 11 bit first header pointer,
 * then 882 bytes of packet zone. Packets run across VCDU boundaries, so a
 * gap in the VCDU counter throws away whatever packet was half built.
 */

export const VCDU_OFFSET = 4
export const MPDU_ZONE = 882
const ZONE_START = VCDU_OFFSET + 10
const NO_HEADER = 0x7ff
const IDLE_APID = 0x7ff
/** Meteor puts the imager on this virtual channel. */
export const IMAGE_VCID = 5

export interface Vcdu {
  scid: number
  vcid: number
  counter: number
}

export function parseVcdu(cadu: Uint8Array): Vcdu {
  const h0 = cadu[VCDU_OFFSET]
  const h1 = cadu[VCDU_OFFSET + 1]
  return {
    scid: ((h0 & 0x3f) << 2) | (h1 >> 6),
    vcid: h1 & 0x3f,
    counter: (cadu[VCDU_OFFSET + 2] << 16) | (cadu[VCDU_OFFSET + 3] << 8) | cadu[VCDU_OFFSET + 4],
  }
}

export interface SpacePacket {
  apid: number
  seq: number
  /** The whole packet, primary header included. */
  bytes: Uint8Array
  /** The VCDU counter of the frame the packet finished in. */
  vcdu: number
}

export class PacketDemux {
  private buf = new Uint8Array(65542 + 6)
  private have = 0
  private need = 0
  private lastCounter = -1
  /** Packets dropped half built because a frame went missing. */
  dropped = 0

  reset(): void {
    this.have = 0
    this.need = 0
    this.lastCounter = -1
    this.dropped = 0
  }

  /** Feeds one corrected CADU on the imaging channel, returns finished packets. */
  push(cadu: Uint8Array, counter: number): SpacePacket[] {
    const out: SpacePacket[] = []
    if (this.lastCounter >= 0 && counter !== ((this.lastCounter + 1) & 0xffffff)) {
      if (this.have > 0) this.dropped++
      this.have = 0
      this.need = 0
    }
    this.lastCounter = counter

    const fhp = ((cadu[ZONE_START - 2] & 0x07) << 8) | cadu[ZONE_START - 1]
    const zone = cadu.subarray(ZONE_START, ZONE_START + MPDU_ZONE)

    if (fhp === NO_HEADER) {
      if (this.have > 0) this.take(zone, 0, MPDU_ZONE, counter, out)
      return out
    }
    if (fhp >= MPDU_ZONE) {
      this.have = 0
      this.need = 0
      return out
    }
    if (this.have > 0) {
      this.take(zone, 0, fhp, counter, out)
      // whatever was in progress should have ended at the pointer.
      if (this.have > 0) {
        this.dropped++
        this.have = 0
        this.need = 0
      }
    }
    let at = fhp
    while (at < MPDU_ZONE) {
      at = this.take(zone, at, MPDU_ZONE, counter, out)
    }
    return out
  }

  /** Copies bytes into the packet in progress. Returns where it stopped. */
  private take(zone: Uint8Array, from: number, to: number, counter: number, out: SpacePacket[]): number {
    let at = from
    while (at < to) {
      if (this.have < 6) {
        const n = Math.min(6 - this.have, to - at)
        this.buf.set(zone.subarray(at, at + n), this.have)
        this.have += n
        at += n
        if (this.have < 6) return at
        this.need = 6 + ((this.buf[4] << 8) | this.buf[5]) + 1
      }
      const n = Math.min(this.need - this.have, to - at)
      this.buf.set(zone.subarray(at, at + n), this.have)
      this.have += n
      at += n
      if (this.have === this.need) {
        const apid = ((this.buf[0] & 0x07) << 8) | this.buf[1]
        if (apid !== IDLE_APID) {
          out.push({
            apid,
            seq: ((this.buf[2] & 0x3f) << 8) | this.buf[3],
            bytes: this.buf.slice(0, this.need),
            vcdu: counter,
          })
        }
        this.have = 0
        this.need = 0
        return at
      }
    }
    return at
  }
}

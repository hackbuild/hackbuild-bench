import type { RadioSystem } from '../systems'

/**
 * Builds synthetic TSBK octets for a system, so the trunk view shows live
 * talkgroup activity in demo mode. Emits an IDEN_UP first so the follower can
 * resolve channels, then grants for the system's talkgroups at random.
 *
 * The octet layout matches what parseTsbk reads, so the demo exercises the
 * same path a real control channel would.
 */
export class DemoControlChannel {
  private system: RadioSystem
  private started = false
  private identSent = false

  constructor(system: RadioSystem) {
    this.system = system
  }

  /** One IDEN_UP that maps iden 1 onto the system's first site frequency. */
  private identUp(): Uint8Array {
    // put base near the system's control channel so grants land in-window.
    const baseHz = this.system.sites[0]?.controlHz[0] ?? 770e6
    const baseUnit = Math.round(baseHz / 5)
    // iden 1, bandwidth 12.5k, spacing 12.5k (100 x 125), offset +45 MHz form.
    const p = new Uint8Array(8)
    const iden = 1
    const bw = 100
    p[0] = (iden << 4) | ((bw >> 5) & 0xf)
    p[1] = ((bw & 0x1f) << 3) | (0 << 2) | ((0 >> 12) & 0x3)
    const offMag = 180
    p[1] = ((bw & 0x1f) << 3) | (0 << 2) | ((offMag >> 12) & 0x3)
    p[2] = (offMag >> 4) & 0xff
    const spacing = 100
    p[3] = ((offMag & 0xf) << 4) | ((spacing >> 6) & 0xf)
    p[4] = ((spacing & 0x3f) << 2) | ((baseUnit >> 30) & 0x3)
    p[5] = (baseUnit >> 22) & 0xff
    p[6] = (baseUnit >> 14) & 0xff
    p[7] = (baseUnit >> 6) & 0xff
    return this.frame(0x3d, 0x00, p)
  }

  /** A group voice grant for a random talkgroup on a nearby channel. */
  private grant(): Uint8Array {
    const tgs = this.system.talkgroups
    const tg = tgs[Math.floor(Math.random() * tgs.length)]
    if (!tg) return this.identUp()
    // channel iden 1, a low channel number so the frequency stays near base.
    const channel = (1 << 12) | (2 + Math.floor(Math.random() * 40))
    const opts = tg.service === 'fire' && Math.random() < 0.1 ? 0x80 : 0x00
    const src = 5550000 + Math.floor(Math.random() * 900)
    const p = new Uint8Array([
      opts,
      (channel >> 8) & 0xff,
      channel & 0xff,
      (tg.id >> 8) & 0xff,
      tg.id & 0xff,
      (src >> 16) & 0xff,
      (src >> 8) & 0xff,
      src & 0xff,
    ])
    return this.frame(0x00, 0x00, p)
  }

  private frame(opcode: number, mfid: number, payload: Uint8Array): Uint8Array {
    const octets = new Uint8Array(12)
    octets[0] = opcode & 0x3f
    octets[1] = mfid
    octets.set(payload.subarray(0, 8), 2)
    return octets
  }

  /** The next TSBK to feed. Sends the identifier first, then grants. */
  next(): Uint8Array {
    this.started = true
    if (!this.identSent) {
      this.identSent = true
      return this.identUp()
    }
    // occasionally resend the identifier the way a real control channel does.
    if (Math.random() < 0.1) return this.identUp()
    return this.grant()
  }

  get running(): boolean {
    return this.started
  }
}

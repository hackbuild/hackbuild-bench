import { SameAfsk } from './afsk'
import { parseSame } from './header'
import type { SameHeader } from './header'

export type { SameHeader } from './header'
export { describeSame, eventName, issuedAt, locationName, originatorName, parseSame } from './header'
export { SAME_BAUD, SAME_MARK_HZ, SAME_SPACE_HZ } from './afsk'

export type SameEvent =
  | { type: 'header'; header: SameHeader; bursts: number }
  /** End of message, the NNNN that closes the voice part. */
  | { type: 'eom' }
  /** A burst that arrived but did not agree with any other. */
  | { type: 'burst'; text: string }

/** Bursts are a second apart, so a longer gap starts a new alert. */
const BURST_GAP_S = 4

/**
 * Audio in, alerts out.
 *
 * Every header is sent three times. One is taken once two copies agree, the
 * rule multimon-ng applies, and when all three differ a character by
 * character vote of the three is tried before giving up.
 */
export class SameDecoder {
  private afsk: SameAfsk | null = null
  private bursts: string[] = []
  private lastAt = -Infinity
  private emitted = false
  private eomSent = false

  onEvent: (e: SameEvent) => void = () => {}

  feed(audio: Float32Array, sampleRate: number): void {
    if (!this.afsk || this.afsk.rate !== sampleRate) {
      this.afsk = new SameAfsk(sampleRate)
      this.afsk.onBurst = (text, at) => this.burst(text, at / sampleRate)
    }
    this.afsk.process(audio)
  }

  reset(): void {
    this.afsk = null
    this.bursts = []
    this.lastAt = -Infinity
    this.emitted = false
    this.eomSent = false
  }

  private burst(text: string, at: number): void {
    if (at - this.lastAt > BURST_GAP_S) {
      this.bursts = []
      this.emitted = false
      this.eomSent = false
    }
    this.lastAt = at
    if (text === 'NNNN') {
      if (!this.eomSent) {
        this.eomSent = true
        this.onEvent({ type: 'eom' })
      }
      return
    }
    this.onEvent({ type: 'burst', text })
    this.bursts.push(text)
    if (this.emitted) return

    const n = this.bursts.length
    for (let i = 0; i < n - 1; i++) {
      if (this.bursts[i] === text) {
        const h = parseSame(text)
        if (h) {
          this.emitted = true
          this.onEvent({ type: 'header', header: h, bursts: n })
        }
        return
      }
    }
    if (n >= 3) {
      const voted = vote(this.bursts.slice(-3))
      const h = voted ? parseSame(voted) : null
      if (h) {
        this.emitted = true
        this.onEvent({ type: 'header', header: h, bursts: n })
      }
    }
  }
}

function vote(copies: string[]): string | null {
  const len = Math.max(...copies.map((c) => c.length))
  let out = ''
  for (let i = 0; i < len; i++) {
    const counts = new Map<string, number>()
    for (const c of copies) {
      const ch = c[i]
      if (ch !== undefined) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }
    let best = ''
    let bestN = 0
    for (const [ch, k] of counts) {
      if (k > bestN) {
        best = ch
        bestN = k
      }
    }
    if (bestN < 2) return null
    out += best
  }
  return out
}

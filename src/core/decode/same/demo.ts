import { BufferedSource } from '../demo'
import type { DemoAudioSource } from '../demo'
import { SAME_BAUD, SAME_MARK_HZ, SAME_SPACE_HZ } from './afsk'

const RATE = 48000
const PREAMBLE_BYTES = 16

/** Day of year and time as JJJHHMM, UTC. */
function julian(at: Date): string {
  const start = Date.UTC(at.getUTCFullYear(), 0, 1)
  const day = Math.floor((at.getTime() - start) / 86_400_000) + 1
  const p = (n: number, w: number) => String(n).padStart(w, '0')
  return `${p(day, 3)}${p(at.getUTCHours(), 2)}${p(at.getUTCMinutes(), 2)}`
}

/**
 * A full NOAA Weather Radio test as the air carries it: the header three
 * times, the 1050 Hz alert tone, then the end of message three times. The
 * tones are the real AFSK, so the decoder does the same work it does on air.
 */
export function sameDemoSource(at = new Date()): DemoAudioSource {
  const header = `ZCZC-WXR-RWT-004013-004021+0030-${julian(at)}-KEC94   -`
  const parts: Float32Array[] = []
  let phase = 0
  const bitLen = RATE / SAME_BAUD

  const silence = (s: number) => parts.push(new Float32Array(Math.round(RATE * s)))
  const tone = (hz: number, s: number) => {
    const n = Math.round(RATE * s)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = 0.4 * Math.sin((2 * Math.PI * hz * i) / RATE)
    parts.push(out)
  }
  const burst = (text: string) => {
    const bytes = [...new Array<number>(PREAMBLE_BYTES).fill(0xab), ...[...text].map((c) => c.charCodeAt(0))]
    const bits: number[] = []
    for (const b of bytes) for (let k = 0; k < 8; k++) bits.push((b >> k) & 1)
    const total = Math.round(bits.length * bitLen)
    const out = new Float32Array(total)
    for (let i = 0; i < total; i++) {
      const bit = bits[Math.min(bits.length - 1, Math.floor(i / bitLen))]
      phase += (2 * Math.PI * (bit ? SAME_MARK_HZ : SAME_SPACE_HZ)) / RATE
      out[i] = 0.5 * Math.sin(phase)
    }
    parts.push(out)
  }

  silence(0.5)
  for (let i = 0; i < 3; i++) {
    burst(header)
    silence(1)
  }
  tone(1050, 3)
  silence(1)
  for (let i = 0; i < 3; i++) {
    burst('NNNN')
    silence(1)
  }

  const len = parts.reduce((n, p) => n + p.length, 0)
  const buf = new Float32Array(len)
  let o = 0
  for (const p of parts) {
    buf.set(p, o)
    o += p.length
  }
  // a little hiss, so the demo is not a perfectly clean channel.
  for (let i = 0; i < len; i++) buf[i] += (Math.random() - 0.5) * 0.05
  return new BufferedSource(buf, RATE)
}

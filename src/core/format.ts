/** Formatters shared by every readout, so units are written one way. */

export function formatHz(hz: number, decimals = 3): string {
  if (!Number.isFinite(hz)) return 'unknown'
  const abs = Math.abs(hz)
  if (abs >= 1e9) return `${(hz / 1e9).toFixed(decimals)} GHz`
  if (abs >= 1e6) return `${(hz / 1e6).toFixed(decimals)} MHz`
  if (abs >= 1e3) return `${(hz / 1e3).toFixed(decimals)} kHz`
  return `${hz.toFixed(0)} Hz`
}

export function formatRate(sps: number): string {
  if (sps >= 1e6) return `${(sps / 1e6).toFixed(sps % 1e6 === 0 ? 0 : 1)} Msps`
  if (sps >= 1e3) return `${(sps / 1e3).toFixed(0)} ksps`
  return `${sps} sps`
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`
  return `${n} B`
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function formatClock(at: number): string {
  const d = new Date(at)
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':')
}

export function toHex(bytes: Uint8Array, sep = ' '): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(sep)
}

export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/[^0-9a-f]/gi, '')
  const out = new Uint8Array(Math.floor(clean.length / 2))
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substr(i * 2, 2), 16)
  }
  return out
}

export function toAscii(bytes: Uint8Array): string {
  return [...bytes].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('')
}

export function formatMac(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(':')
}

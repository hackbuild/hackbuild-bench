/**
 * Statistical measures over a byte buffer, plus the checksum identifier.
 *
 * Everything here is synchronous and allocation light so magic can call it a
 * few hundred times per search without blocking a frame.
 */

/** Bytes to a string one char per byte, so byte 0xa5 survives as U+00A5. */
export function decodeLatin1(bytes: Uint8Array): string {
  let s = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
  }
  return s
}

/** Inverse of decodeLatin1. Chars above 0xff are truncated to their low byte. */
export function encodeLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function byteHistogram(bytes: Uint8Array): Uint32Array {
  const hist = new Uint32Array(256)
  for (let i = 0; i < bytes.length; i++) hist[bytes[i]]++
  return hist
}

/** Bits per byte, 0 for a constant buffer and 8 for uniform random. */
export function shannonEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0
  const hist = byteHistogram(bytes)
  const n = bytes.length
  let h = 0
  for (let i = 0; i < 256; i++) {
    const c = hist[i]
    if (c === 0) continue
    const p = c / n
    h -= p * Math.log2(p)
  }
  return h
}

function isPrintable(b: number): boolean {
  return b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)
}

export function printableRatio(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0
  let n = 0
  for (let i = 0; i < bytes.length; i++) if (isPrintable(bytes[i])) n++
  return n / bytes.length
}

/**
 * Index of coincidence over the letters only. English running text sits near
 * 0.066, a polyalphabetic cipher near 0.038, uniform bytes near 0.
 */
export function indexOfCoincidence(bytes: Uint8Array): number {
  const counts = new Uint32Array(26)
  let n = 0
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i] | 0x20
    if (c >= 0x61 && c <= 0x7a) {
      counts[c - 0x61]++
      n++
    }
  }
  if (n < 2) return 0
  let sum = 0
  for (let i = 0; i < 26; i++) sum += counts[i] * (counts[i] - 1)
  return sum / (n * (n - 1))
}

/** Letter frequency of English text in percent, a through z. */
const ENGLISH_FREQ = [
  8.167, 1.492, 2.782, 4.253, 12.702, 2.228, 2.015, 6.094, 6.966, 0.153, 0.772, 4.025, 2.406,
  6.749, 7.507, 1.929, 0.095, 5.987, 6.327, 9.056, 2.758, 0.978, 2.36, 0.15, 1.974, 0.074,
]

/**
 * General English plus the vocabulary that actually shows up in firmware
 * strings, console banners, and remote control payloads on this bench.
 */
const COMMON_WORDS = [
  'the', 'and', 'you', 'that', 'for', 'with', 'are', 'this', 'have', 'from', 'not', 'but',
  'all', 'your', 'can', 'out', 'one', 'was', 'his', 'her', 'they', 'been', 'when', 'what',
  'open', 'close', 'lock', 'unlock', 'door', 'gate', 'garage', 'press', 'button', 'key',
  'code', 'start', 'stop', 'error', 'fail', 'ready', 'init', 'boot', 'version', 'serial',
  'device', 'status', 'reset', 'send', 'recv', 'data', 'time', 'name', 'test', 'mode',
]

const LETTER_NORM = (() => {
  let sq = 0
  for (const f of ENGLISH_FREQ) sq += (f / 100) * (f / 100)
  return Math.sqrt(sq)
})()

/** Cosine of a letter count vector against the English distribution. */
export function letterFit(counts: ArrayLike<number>, letters: number): number {
  if (letters < 2) return 0
  let dot = 0
  let na = 0
  for (let i = 0; i < 26; i++) {
    const a = counts[i] / letters
    dot += a * (ENGLISH_FREQ[i] / 100)
    na += a * a
  }
  const denom = Math.sqrt(na) * LETTER_NORM
  return denom > 0 ? clamp01(dot / denom) : 0
}

/**
 * 0 to 1. Letter distribution, word hits, and word spacing, all scaled by how
 * much of the buffer is printable at all, so binary never scores as English.
 */
export function englishScore(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0
  const counts = new Uint32Array(26)
  let letters = 0
  let printable = 0
  let spaces = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (isPrintable(b)) printable++
    if (b === 0x20) spaces++
    const c = b | 0x20
    if (c >= 0x61 && c <= 0x7a) {
      counts[c - 0x61]++
      letters++
    }
  }
  const pr = printable / bytes.length
  if (pr < 0.5 || letters < 2) return pr * 0.05

  const fit = letterFit(counts, letters)
  const text = decodeLatin1(bytes).toLowerCase()
  let hits = 0
  for (const w of COMMON_WORDS) if (text.includes(w)) hits++
  const words = Math.min(1, hits / 5)
  const spaceRatio = spaces / bytes.length
  const spacing = spaceRatio >= 0.05 && spaceRatio <= 0.3 ? 1 : spaceRatio > 0 ? 0.4 : 0
  const density = letters / bytes.length

  return clamp01(pr * (0.45 * fit + 0.3 * words + 0.15 * spacing + 0.1 * density))
}

export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  return printableRatio(bytes) >= 0.85 && shannonEntropy(bytes) < 6
}

/** How many of the known words the buffer contains, counted once each. */
export function wordHits(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0
  const text = decodeLatin1(bytes).toLowerCase()
  let hits = 0
  for (const w of COMMON_WORDS) if (text.includes(w)) hits++
  return hits
}

export type Utf8Kind = 'ascii' | 'utf8' | 'invalid'

/**
 * Strict. Overlong encodings, surrogate code points, and truncated tails all
 * come back invalid, so a buffer that happens to hold high bytes is not
 * reported as text.
 */
export function utf8Kind(bytes: Uint8Array): Utf8Kind {
  let multibyte = false
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    if (b < 0x80) {
      i++
      continue
    }
    let need: number
    let cp: number
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1
      cp = b & 0x1f
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2
      cp = b & 0x0f
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3
      cp = b & 0x07
    } else {
      return 'invalid'
    }
    if (i + need >= bytes.length) return 'invalid'
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k]
      if (c < 0x80 || c > 0xbf) return 'invalid'
      cp = (cp << 6) | (c & 0x3f)
    }
    if (need === 2 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) return 'invalid'
    if (need === 3 && (cp < 0x10000 || cp > 0x10ffff)) return 'invalid'
    multibyte = true
    i += need + 1
  }
  return multibyte ? 'utf8' : 'ascii'
}

/** The measures a scorer compares before and after an operation. */
export interface TextProfile {
  length: number
  printable: number
  entropy: number
  english: number
  words: number
  spaceRatio: number
  utf8: Utf8Kind
}

export function profileBytes(bytes: Uint8Array): TextProfile {
  let spaces = 0
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x20) spaces++
  return {
    length: bytes.length,
    printable: printableRatio(bytes),
    entropy: shannonEntropy(bytes),
    english: englishScore(bytes),
    words: wordHits(bytes),
    spaceRatio: bytes.length ? spaces / bytes.length : 0,
    utf8: utf8Kind(bytes),
  }
}

// ---------------------------------------------------------------------------
// checksums
// ---------------------------------------------------------------------------

export function crc8(bytes: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
  }
  return crc
}

/** CCITT false, init 0xffff, poly 0x1021, most significant bit first. */
export function crc16Ccitt(bytes: Uint8Array): number {
  let crc = 0xffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

/** Modbus, init 0xffff, reflected poly 0xa001, sent low byte first. */
export function crc16Modbus(bytes: Uint8Array): number {
  let crc = 0xffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]
    for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
  }
  return crc & 0xffff
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let b = 0; b < 8; b++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function sum8(bytes: Uint8Array): number {
  let s = 0
  for (let i = 0; i < bytes.length; i++) s = (s + bytes[i]) & 0xff
  return s
}

export interface ChecksumHit {
  name: string
  confidence: number
}

interface Candidate {
  name: string
  width: number
  compute(body: Uint8Array): number
  /** false means the trailing bytes are most significant byte first. */
  little: boolean
}

const CHECKSUMS: Candidate[] = [
  { name: 'crc8', width: 1, compute: crc8, little: true },
  { name: 'crc16 ccitt', width: 2, compute: crc16Ccitt, little: false },
  { name: 'crc16 ccitt le', width: 2, compute: crc16Ccitt, little: true },
  { name: 'crc16 modbus', width: 2, compute: crc16Modbus, little: true },
  { name: 'crc32', width: 4, compute: crc32, little: true },
  { name: 'crc32 be', width: 4, compute: crc32, little: false },
  { name: 'additive sum8', width: 1, compute: sum8, little: true },
]

function trailing(frame: Uint8Array, width: number, little: boolean): number {
  let v = 0
  for (let i = 0; i < width; i++) {
    const b = frame[frame.length - width + i]
    v = little ? v | (b << (8 * i)) : (v << 8) | b
  }
  return v >>> 0
}

/**
 * Try each candidate over the frames minus their trailing bytes. Confidence is
 * the match rate scaled down when there are too few frames for the match to
 * mean much: one lucky crc8 hit is a one in 256 coincidence.
 */
export function detectChecksum(frames: Uint8Array[]): ChecksumHit | null {
  let best: ChecksumHit | null = null
  for (const c of CHECKSUMS) {
    let usable = 0
    let matched = 0
    for (const frame of frames) {
      if (frame.length < c.width + 2) continue
      usable++
      const body = frame.subarray(0, frame.length - c.width)
      if (c.compute(body) === trailing(frame, c.width, c.little)) matched++
    }
    if (usable === 0 || matched === 0) continue
    const ratio = matched / usable
    const evidence = Math.min(1, 0.35 + 0.2 * usable)
    const confidence = ratio * evidence
    if (!best || confidence > best.confidence) best = { name: c.name, confidence }
  }
  return best && best.confidence >= 0.5 ? best : null
}

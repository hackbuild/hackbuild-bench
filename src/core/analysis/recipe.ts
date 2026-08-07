/**
 * The recipe engine. An operation is a pure byte to byte function with a
 * declared argument schema. bake chains them.
 *
 * Every run() is synchronous because magic speculates over several hundred
 * branches per search and cannot afford an await per node. That constraint is
 * why gunzip carries its own inflate: DecompressionStream is async only.
 * gunzipStream below is the DecompressionStream path for callers that can wait.
 */

import { decodeLatin1, encodeLatin1, englishScore, printableRatio } from '@/core/analysis/metrics'

export interface ArgSpec {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select'
  default: unknown
  choices?: string[]
}

export interface Operation {
  id: string
  label: string
  args: ArgSpec[]
  run(input: Uint8Array, args: Record<string, unknown>): Uint8Array
}

export interface RecipeStep {
  opId: string
  args: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// argument access. the editor hands strings back for number fields, so every
// reader coerces rather than trusting the declared type.
// ---------------------------------------------------------------------------

function argStr(args: Record<string, unknown>, key: string, fallback: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : fallback
}

function argNum(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function argBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key]
  return typeof v === 'boolean' ? v : fallback
}

const DELIMITERS: Record<string, string> = {
  space: ' ',
  none: '',
  comma: ',',
  colon: ':',
  newline: '\n',
}

const DELIM_CHOICES = ['space', 'none', 'comma', 'colon', 'newline']

// ---------------------------------------------------------------------------
// codecs
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef'

function toHexString(bytes: Uint8Array, delim: string, upper: boolean): string {
  const parts: string[] = new Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    const s = HEX[b >> 4] + HEX[b & 0x0f]
    parts[i] = upper ? s.toUpperCase() : s
  }
  return parts.join(delim)
}

function fromHexString(text: string): Uint8Array {
  const stripped = text.replace(/0[xX]([0-9a-fA-F]{2})/g, '$1').replace(/[^0-9a-fA-F]/g, '')
  if (stripped.length === 0) throw new Error('no hex digits in the input')
  if (stripped.length % 2 !== 0) throw new Error('hex input has an odd number of digits')
  const out = new Uint8Array(stripped.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(stripped.substr(i * 2, 2), 16)
  return out
}

const B64_ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1)
  for (let i = 0; i < B64_ALPHA.length; i++) t[B64_ALPHA.charCodeAt(i)] = i
  t['-'.charCodeAt(0)] = 62
  t['_'.charCodeAt(0)] = 63
  return t
})()

function toBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64_ALPHA[a >> 2]
    out += B64_ALPHA[((a & 3) << 4) | (b >> 4)]
    out += i + 1 < bytes.length ? B64_ALPHA[((b & 15) << 2) | (c >> 6)] : '='
    out += i + 2 < bytes.length ? B64_ALPHA[c & 63] : '='
  }
  return out
}

function fromBase64(text: string): Uint8Array {
  const vals: number[] = []
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 255) throw new Error('input is not base64')
    const v = B64_LOOKUP[code]
    if (v >= 0) vals.push(v)
    else if (code === 0x3d || code === 0x0a || code === 0x0d || code === 0x20 || code === 0x09) continue
    else throw new Error(`character ${JSON.stringify(text[i])} is not in the base64 alphabet`)
  }
  if (vals.length < 2) throw new Error('not enough base64 characters to decode')
  const out = new Uint8Array(Math.floor((vals.length * 6) / 8))
  let acc = 0
  let bits = 0
  let o = 0
  for (const v of vals) {
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

function parseKey(key: string, format: string): Uint8Array {
  if (key === '') throw new Error('this operation needs a key')
  if (format === 'hex') return fromHexString(key)
  if (format === 'decimal') {
    const parts = key.split(/[^0-9]+/).filter((p) => p !== '')
    if (parts.length === 0) throw new Error('key has no decimal values')
    return Uint8Array.from(parts.map((p) => Number(p) & 0xff))
  }
  return new TextEncoder().encode(key)
}

function xorWith(input: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(input.length)
  for (let i = 0; i < input.length; i++) out[i] = input[i] ^ key[i % key.length]
  return out
}

function caesarShift(input: Uint8Array, shift: number): Uint8Array {
  const s = ((shift % 26) + 26) % 26
  const out = new Uint8Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const b = input[i]
    if (b >= 0x41 && b <= 0x5a) out[i] = ((b - 0x41 + s) % 26) + 0x41
    else if (b >= 0x61 && b <= 0x7a) out[i] = ((b - 0x61 + s) % 26) + 0x61
    else out[i] = b
  }
  return out
}

function vigenere(input: Uint8Array, key: string, decode: boolean): Uint8Array {
  const shifts: number[] = []
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i) | 0x20
    if (c >= 0x61 && c <= 0x7a) shifts.push(c - 0x61)
  }
  if (shifts.length === 0) throw new Error('vigenere key must contain letters')
  const out = new Uint8Array(input.length)
  let k = 0
  for (let i = 0; i < input.length; i++) {
    const b = input[i]
    const upper = b >= 0x41 && b <= 0x5a
    const lower = b >= 0x61 && b <= 0x7a
    if (!upper && !lower) {
      out[i] = b
      continue
    }
    const base = upper ? 0x41 : 0x61
    const s = decode ? 26 - shifts[k % shifts.length] : shifts[k % shifts.length]
    out[i] = ((b - base + s) % 26) + base
    k++
  }
  return out
}

function rotateBits(input: Uint8Array, amount: number, left: boolean): Uint8Array {
  const n = ((amount % 8) + 8) % 8
  const out = new Uint8Array(input.length)
  if (n === 0) {
    out.set(input)
    return out
  }
  const l = left ? n : 8 - n
  for (let i = 0; i < input.length; i++) {
    const b = input[i]
    out[i] = ((b << l) | (b >>> (8 - l))) & 0xff
  }
  return out
}

function urlEncode(input: Uint8Array, spaceAsPlus: boolean): Uint8Array {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const b = input[i]
    const c = String.fromCharCode(b)
    if (/[A-Za-z0-9\-_.~]/.test(c)) out += c
    else if (b === 0x20 && spaceAsPlus) out += '+'
    else out += '%' + HEX[b >> 4].toUpperCase() + HEX[b & 0x0f].toUpperCase()
  }
  return encodeLatin1(out)
}

function urlDecode(input: Uint8Array, plusAsSpace: boolean): Uint8Array {
  const out = new Uint8Array(input.length)
  let o = 0
  for (let i = 0; i < input.length; i++) {
    const b = input[i]
    if (b === 0x25) {
      const hi = input[i + 1]
      const lo = input[i + 2]
      const v = parseInt(String.fromCharCode(hi, lo), 16)
      if (!Number.isFinite(v)) throw new Error('percent escape is not followed by two hex digits')
      out[o++] = v
      i += 2
    } else if (b === 0x2b && plusAsSpace) {
      out[o++] = 0x20
    } else {
      out[o++] = b
    }
  }
  return out.slice(0, o)
}

// ---------------------------------------------------------------------------
// inflate. puff style canonical huffman, enough for gzip, zlib, and raw
// deflate streams produced by anything the bench is likely to meet.
// ---------------------------------------------------------------------------

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
]
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
]
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

interface Huff {
  counts: Int32Array
  symbols: Int32Array
}

function buildHuff(lengths: Uint8Array, n: number): Huff {
  const counts = new Int32Array(16)
  for (let i = 0; i < n; i++) counts[lengths[i]]++
  counts[0] = 0
  const offs = new Int32Array(16)
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + counts[len]
  const symbols = new Int32Array(n)
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbols[offs[lengths[i]]++] = i
  return { counts, symbols }
}

const FIXED_LIT = (() => {
  const l = new Uint8Array(288)
  for (let i = 0; i < 144; i++) l[i] = 8
  for (let i = 144; i < 256; i++) l[i] = 9
  for (let i = 256; i < 280; i++) l[i] = 7
  for (let i = 280; i < 288; i++) l[i] = 8
  return buildHuff(l, 288)
})()

const FIXED_DIST = buildHuff(new Uint8Array(30).fill(5), 30)

class Inflater {
  private data: Uint8Array
  private pos: number
  private bitBuf = 0
  private bitCnt = 0
  private out: Uint8Array
  private len = 0

  constructor(data: Uint8Array, start: number) {
    this.data = data
    this.pos = start
    this.out = new Uint8Array(Math.max(1024, (data.length - start) * 4))
  }

  private bits(n: number): number {
    while (this.bitCnt < n) {
      if (this.pos >= this.data.length) throw new Error('gunzip: the deflate stream ends early')
      this.bitBuf |= this.data[this.pos++] << this.bitCnt
      this.bitCnt += 8
    }
    const v = this.bitBuf & ((1 << n) - 1)
    this.bitBuf >>>= n
    this.bitCnt -= n
    return v
  }

  private byte(): number {
    if (this.pos >= this.data.length) throw new Error('gunzip: the deflate stream ends early')
    return this.data[this.pos++]
  }

  private put(b: number): void {
    if (this.len === this.out.length) {
      const bigger = new Uint8Array(this.out.length * 2)
      bigger.set(this.out)
      this.out = bigger
    }
    this.out[this.len++] = b
  }

  private decode(h: Huff): number {
    let code = 0
    let first = 0
    let index = 0
    for (let len = 1; len <= 15; len++) {
      code |= this.bits(1)
      const count = h.counts[len]
      if (code - first < count) return h.symbols[index + (code - first)]
      index += count
      first = (first + count) << 1
      code <<= 1
    }
    throw new Error('gunzip: invalid huffman code')
  }

  private block(lit: Huff, dist: Huff): void {
    for (;;) {
      const sym = this.decode(lit)
      if (sym < 256) {
        this.put(sym)
      } else if (sym === 256) {
        return
      } else {
        const li = sym - 257
        if (li >= LEN_BASE.length) throw new Error('gunzip: invalid length symbol')
        const length = LEN_BASE[li] + this.bits(LEN_EXTRA[li])
        const di = this.decode(dist)
        if (di >= DIST_BASE.length) throw new Error('gunzip: invalid distance symbol')
        const distance = DIST_BASE[di] + this.bits(DIST_EXTRA[di])
        if (distance > this.len) throw new Error('gunzip: back reference points before the output')
        for (let i = 0; i < length; i++) this.put(this.out[this.len - distance])
      }
    }
  }

  private dynamicTables(): [Huff, Huff] {
    const nlen = this.bits(5) + 257
    const ndist = this.bits(5) + 1
    const ncode = this.bits(4) + 4
    if (nlen > 286 || ndist > 30) throw new Error('gunzip: too many length or distance codes')
    const clens = new Uint8Array(19)
    for (let i = 0; i < ncode; i++) clens[CLEN_ORDER[i]] = this.bits(3)
    const clenHuff = buildHuff(clens, 19)
    const lengths = new Uint8Array(nlen + ndist)
    let i = 0
    while (i < nlen + ndist) {
      const sym = this.decode(clenHuff)
      if (sym < 16) {
        lengths[i++] = sym
      } else if (sym === 16) {
        if (i === 0) throw new Error('gunzip: repeat with no previous code length')
        const prev = lengths[i - 1]
        let rep = 3 + this.bits(2)
        while (rep-- > 0 && i < lengths.length) lengths[i++] = prev
      } else if (sym === 17) {
        let rep = 3 + this.bits(3)
        while (rep-- > 0 && i < lengths.length) lengths[i++] = 0
      } else {
        let rep = 11 + this.bits(7)
        while (rep-- > 0 && i < lengths.length) lengths[i++] = 0
      }
    }
    return [buildHuff(lengths.subarray(0, nlen), nlen), buildHuff(lengths.subarray(nlen), ndist)]
  }

  run(): Uint8Array {
    let last = 0
    do {
      last = this.bits(1)
      const type = this.bits(2)
      if (type === 0) {
        this.bitBuf = 0
        this.bitCnt = 0
        const l = this.byte() | (this.byte() << 8)
        const nl = this.byte() | (this.byte() << 8)
        if ((l ^ 0xffff) !== nl) throw new Error('gunzip: stored block length check failed')
        for (let i = 0; i < l; i++) this.put(this.byte())
      } else if (type === 1) {
        this.block(FIXED_LIT, FIXED_DIST)
      } else if (type === 2) {
        const [lit, dist] = this.dynamicTables()
        this.block(lit, dist)
      } else {
        throw new Error('gunzip: reserved deflate block type')
      }
    } while (last === 0)
    return this.out.slice(0, this.len)
  }
}

/** Accepts a gzip member, a zlib stream, or bare deflate. */
export function gunzip(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 3) throw new Error('gunzip: input is too short to hold a compressed stream')
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (bytes[2] !== 8) throw new Error('gunzip: gzip member is not deflate compressed')
    const flg = bytes[3]
    let p = 10
    if (flg & 0x04) {
      const xlen = bytes[p] | (bytes[p + 1] << 8)
      p += 2 + xlen
    }
    if (flg & 0x08) {
      while (p < bytes.length && bytes[p] !== 0) p++
      p++
    }
    if (flg & 0x10) {
      while (p < bytes.length && bytes[p] !== 0) p++
      p++
    }
    if (flg & 0x02) p += 2
    if (p >= bytes.length) throw new Error('gunzip: gzip header runs past the end of the input')
    return new Inflater(bytes, p).run()
  }
  if ((bytes[0] & 0x0f) === 8 && (((bytes[0] << 8) | bytes[1]) % 31) === 0) {
    return new Inflater(bytes, 2).run()
  }
  return new Inflater(bytes, 0).run()
}

/** The DecompressionStream path, for callers on an async boundary. */
export async function gunzipStream(bytes: Uint8Array, format: 'gzip' | 'deflate' = 'gzip'): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser has no DecompressionStream')
  }
  const source = new Blob([bytes as BlobPart]).stream()
  const out = source.pipeThrough(new DecompressionStream(format))
  const chunks: Uint8Array[] = []
  const reader = out.getReader()
  let total = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      total += value.length
    }
  }
  const merged = new Uint8Array(total)
  let o = 0
  for (const c of chunks) {
    merged.set(c, o)
    o += c.length
  }
  return merged
}

// ---------------------------------------------------------------------------
// the operation table
// ---------------------------------------------------------------------------

export const OPERATIONS: Operation[] = [
  {
    id: 'raw',
    label: 'raw passthrough',
    args: [],
    run: (input) => input,
  },
  {
    id: 'from-hex',
    label: 'from hex',
    args: [],
    run: (input) => fromHexString(decodeLatin1(input)),
  },
  {
    id: 'to-hex',
    label: 'to hex',
    args: [
      { key: 'delimiter', label: 'delimiter', type: 'select', default: 'space', choices: DELIM_CHOICES },
      { key: 'uppercase', label: 'uppercase', type: 'boolean', default: false },
    ],
    run: (input, args) =>
      encodeLatin1(
        toHexString(
          input,
          DELIMITERS[argStr(args, 'delimiter', 'space')] ?? ' ',
          argBool(args, 'uppercase', false),
        ),
      ),
  },
  {
    id: 'from-base64',
    label: 'from base64',
    args: [],
    run: (input) => fromBase64(decodeLatin1(input)),
  },
  {
    id: 'to-base64',
    label: 'to base64',
    args: [],
    run: (input) => encodeLatin1(toBase64(input)),
  },
  {
    id: 'url-decode',
    label: 'url decode',
    args: [{ key: 'plusAsSpace', label: 'treat + as space', type: 'boolean', default: true }],
    run: (input, args) => urlDecode(input, argBool(args, 'plusAsSpace', true)),
  },
  {
    id: 'url-encode',
    label: 'url encode',
    args: [{ key: 'spaceAsPlus', label: 'encode space as +', type: 'boolean', default: false }],
    run: (input, args) => urlEncode(input, argBool(args, 'spaceAsPlus', false)),
  },
  {
    id: 'xor',
    label: 'xor with a key',
    args: [
      { key: 'key', label: 'key', type: 'string', default: '' },
      { key: 'format', label: 'key format', type: 'select', default: 'hex', choices: ['hex', 'utf8', 'decimal'] },
    ],
    run: (input, args) => xorWith(input, parseKey(argStr(args, 'key', ''), argStr(args, 'format', 'hex'))),
  },
  {
    id: 'xor-brute',
    label: 'xor brute force, single byte',
    args: [],
    run: (input) => {
      let best = input
      let bestScore = -1
      for (let k = 0; k < 256; k++) {
        const out = xorWith(input, Uint8Array.of(k))
        const score = printableRatio(out) * 0.4 + englishScore(out) * 0.6
        if (score > bestScore) {
          bestScore = score
          best = out
        }
      }
      return best
    },
  },
  {
    id: 'rot13',
    label: 'rot13',
    args: [],
    run: (input) => caesarShift(input, 13),
  },
  {
    id: 'caesar',
    label: 'caesar with a shift',
    args: [{ key: 'shift', label: 'shift', type: 'number', default: 3 }],
    run: (input, args) => caesarShift(input, argNum(args, 'shift', 3)),
  },
  {
    id: 'vigenere',
    label: 'vigenere with a key',
    args: [
      { key: 'key', label: 'key', type: 'string', default: '' },
      { key: 'mode', label: 'mode', type: 'select', default: 'decode', choices: ['decode', 'encode'] },
    ],
    run: (input, args) =>
      vigenere(input, argStr(args, 'key', ''), argStr(args, 'mode', 'decode') === 'decode'),
  },
  {
    id: 'reverse',
    label: 'reverse',
    args: [],
    run: (input) => {
      const out = new Uint8Array(input.length)
      for (let i = 0; i < input.length; i++) out[i] = input[input.length - 1 - i]
      return out
    },
  },
  {
    id: 'rotate-left',
    label: 'bit rotate left',
    args: [{ key: 'amount', label: 'bits', type: 'number', default: 1 }],
    run: (input, args) => rotateBits(input, argNum(args, 'amount', 1), true),
  },
  {
    id: 'rotate-right',
    label: 'bit rotate right',
    args: [{ key: 'amount', label: 'bits', type: 'number', default: 1 }],
    run: (input, args) => rotateBits(input, argNum(args, 'amount', 1), false),
  },
  {
    id: 'gunzip',
    label: 'gunzip',
    args: [],
    run: (input) => gunzip(input),
  },
  {
    id: 'from-binary',
    label: 'from binary',
    args: [],
    run: (input) => {
      const bits = decodeLatin1(input).replace(/[^01]/g, '')
      if (bits.length < 8) throw new Error('fewer than eight binary digits in the input')
      const n = Math.floor(bits.length / 8)
      const out = new Uint8Array(n)
      for (let i = 0; i < n; i++) out[i] = parseInt(bits.substr(i * 8, 8), 2)
      return out
    },
  },
  {
    id: 'to-binary',
    label: 'to binary',
    args: [
      { key: 'delimiter', label: 'delimiter', type: 'select', default: 'space', choices: DELIM_CHOICES },
    ],
    run: (input, args) => {
      const delim = DELIMITERS[argStr(args, 'delimiter', 'space')] ?? ' '
      const parts: string[] = new Array(input.length)
      for (let i = 0; i < input.length; i++) parts[i] = input[i].toString(2).padStart(8, '0')
      return encodeLatin1(parts.join(delim))
    },
  },
  {
    id: 'from-decimal',
    label: 'from decimal',
    args: [],
    run: (input) => {
      const parts = decodeLatin1(input)
        .split(/[^0-9]+/)
        .filter((p) => p !== '')
      if (parts.length === 0) throw new Error('no decimal values in the input')
      const out = new Uint8Array(parts.length)
      for (let i = 0; i < parts.length; i++) {
        const v = Number(parts[i])
        if (v > 255) throw new Error(`${v} does not fit in a byte`)
        out[i] = v
      }
      return out
    },
  },
  {
    id: 'take-slice',
    label: 'take slice',
    args: [
      { key: 'start', label: 'start', type: 'number', default: 0 },
      { key: 'length', label: 'length, 0 for the rest', type: 'number', default: 0 },
    ],
    run: (input, args) => {
      const start = Math.max(0, Math.floor(argNum(args, 'start', 0)))
      const length = Math.floor(argNum(args, 'length', 0))
      if (start >= input.length) throw new Error('slice starts past the end of the input')
      const end = length > 0 ? Math.min(input.length, start + length) : input.length
      return input.slice(start, end)
    },
  },
  {
    id: 'drop-bytes',
    label: 'drop bytes',
    args: [
      { key: 'count', label: 'count', type: 'number', default: 1 },
      { key: 'from', label: 'from', type: 'select', default: 'start', choices: ['start', 'end'] },
    ],
    run: (input, args) => {
      const count = Math.max(0, Math.floor(argNum(args, 'count', 1)))
      if (count >= input.length) throw new Error('dropping that many bytes leaves nothing')
      return argStr(args, 'from', 'start') === 'end'
        ? input.slice(0, input.length - count)
        : input.slice(count)
    },
  },
]

const BY_ID = new Map(OPERATIONS.map((op) => [op.id, op]))

export function operation(id: string): Operation | undefined {
  return BY_ID.get(id)
}

/**
 * A step with every declared argument present. Callers that build steps from a
 * search result only carry the arguments that mattered to the search, and the
 * editor needs a value in every field it renders.
 */
export function makeStep(opId: string, args: Record<string, unknown> = {}): RecipeStep {
  const op = BY_ID.get(opId)
  const defaults = op ? Object.fromEntries(op.args.map((a) => [a.key, a.default])) : {}
  return { opId, args: { ...defaults, ...args } }
}

/**
 * Run the chain. Never throws: a failing step stops the chain and the partial
 * output comes back with the message, so the editor can show how far it got.
 */
export function bake(
  input: Uint8Array,
  steps: RecipeStep[],
): { output: Uint8Array; error?: string; perStep: Uint8Array[] } {
  const perStep: Uint8Array[] = []
  let current = input
  for (const step of steps) {
    const op = BY_ID.get(step.opId)
    if (!op) {
      return { output: current, error: `no operation called ${step.opId}`, perStep }
    }
    try {
      current = op.run(current, step.args ?? {})
      perStep.push(current)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: current, error: `${op.label}: ${message}`, perStep }
    }
  }
  return { output: current, perStep }
}

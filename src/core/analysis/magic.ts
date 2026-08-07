/**
 * Auto detect. Runs every operation speculatively, scores each branch, and
 * keeps walking the branches that got closer to readable text.
 *
 * The search is a beam, not an exhaustive tree. Without the beam the intensive
 * keyspaces would multiply out to millions of nodes at depth three and lock the
 * main thread.
 */

import {
  byteHistogram,
  clamp01,
  englishScore,
  letterFit,
  printableRatio,
  shannonEntropy,
} from '@/core/analysis/metrics'
import { operation } from '@/core/analysis/recipe'
import type { Operation } from '@/core/analysis/recipe'

export interface MagicHit {
  opId: string
  args: Record<string, unknown>
  label: string
  confidence: number
  preview: string
  depth: number
}

interface Candidate {
  opId: string
  args: Record<string, unknown>
}

interface Node {
  parent: number
  opId: string
  args: Record<string, unknown>
  label: string
  bytes: Uint8Array
  depth: number
  quality: number
  confidence: number
}

/** Ops that usually make things look worse before they look better. */
const DECODERS = new Set(['from-hex', 'from-base64', 'from-binary', 'from-decimal', 'url-decode', 'gunzip'])

/** How much of the input the search reasons over. Full buffers stay untouched. */
const SPECULATE_BYTES = 1024
const BEAM = 8
const STRUCTURAL_KEEP = 4
const MAX_HITS = 12

function quality(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0
  const pr = printableRatio(bytes)
  const ent = shannonEntropy(bytes)
  const flat = 1 - Math.min(ent, 8) / 8
  const eng = pr > 0.5 ? englishScore(bytes) : 0
  return 0.4 * pr + 0.45 * eng + 0.15 * flat
}

function preview(bytes: Uint8Array): string {
  const n = Math.min(72, bytes.length)
  let s = ''
  for (let i = 0; i < n; i++) {
    const b = bytes[i]
    s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'
  }
  return bytes.length > n ? s + '...' : s
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** Cheap key for dedup. Length plus a rolling hash over the first kilobyte. */
function fingerprint(bytes: Uint8Array): string {
  let h = 2166136261
  const n = Math.min(bytes.length, 1024)
  for (let i = 0; i < n; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 16777619)
  }
  return `${bytes.length}:${h >>> 0}`
}

// ---------------------------------------------------------------------------
// keyspace scanning. xor, caesar, and bit rotation are all byte permutations,
// so every key can be scored off one histogram instead of one full rewrite.
// ---------------------------------------------------------------------------

function scoreMap(hist: Uint32Array, map: Uint8Array, total: number): number {
  const letters = new Uint32Array(26)
  let printable = 0
  let letterCount = 0
  let spaces = 0
  for (let b = 0; b < 256; b++) {
    const c = hist[b]
    if (c === 0) continue
    const m = map[b]
    if (m === 0x09 || m === 0x0a || m === 0x0d || (m >= 0x20 && m <= 0x7e)) printable += c
    if (m === 0x20) spaces += c
    const l = m | 0x20
    if (l >= 0x61 && l <= 0x7a) {
      letters[l - 0x61] += c
      letterCount += c
    }
  }
  const pr = printable / total
  const fit = letterFit(letters, letterCount)
  const spaceRatio = spaces / total
  const spacing = spaceRatio >= 0.05 && spaceRatio <= 0.3 ? 1 : 0
  return pr * (0.55 + 0.3 * fit + 0.15 * spacing)
}

function mapXor(k: number): Uint8Array {
  const m = new Uint8Array(256)
  for (let b = 0; b < 256; b++) m[b] = b ^ k
  return m
}

function mapCaesar(shift: number): Uint8Array {
  const m = new Uint8Array(256)
  const s = ((shift % 26) + 26) % 26
  for (let b = 0; b < 256; b++) {
    if (b >= 0x41 && b <= 0x5a) m[b] = ((b - 0x41 + s) % 26) + 0x41
    else if (b >= 0x61 && b <= 0x7a) m[b] = ((b - 0x61 + s) % 26) + 0x61
    else m[b] = b
  }
  return m
}

function mapRotate(amount: number, left: boolean): Uint8Array {
  const m = new Uint8Array(256)
  const l = left ? amount : 8 - amount
  for (let b = 0; b < 256; b++) m[b] = ((b << l) | (b >>> (8 - l))) & 0xff
  return m
}

interface Scored {
  key: number
  score: number
}

function topKeys(
  hist: Uint32Array,
  total: number,
  keys: number[],
  build: (k: number) => Uint8Array,
  keep: number,
): number[] {
  const scored: Scored[] = keys.map((key) => ({ key, score: scoreMap(hist, build(key), total) }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, keep).map((s) => s.key)
}

const RANGE_1_255 = Array.from({ length: 255 }, (_, i) => i + 1)
const RANGE_1_25 = Array.from({ length: 25 }, (_, i) => i + 1)
const RANGE_1_7 = Array.from({ length: 7 }, (_, i) => i + 1)

function candidatesFor(bytes: Uint8Array, intensive: boolean): Candidate[] {
  const out: Candidate[] = []
  for (const id of DECODERS) out.push({ opId: id, args: {} })
  out.push({ opId: 'reverse', args: {} })
  out.push({ opId: 'rot13', args: {} })

  if (bytes.length === 0) {
    out.push({ opId: 'xor-brute', args: {} })
    return out
  }
  const hist = byteHistogram(bytes)
  const total = bytes.length

  const xorKeep = intensive ? 4 : 1
  for (const k of topKeys(hist, total, RANGE_1_255, mapXor, xorKeep)) {
    out.push({ opId: 'xor', args: { key: k.toString(16).padStart(2, '0'), format: 'hex' } })
  }

  if (intensive) {
    for (const s of topKeys(hist, total, RANGE_1_25, mapCaesar, 3)) {
      out.push({ opId: 'caesar', args: { shift: s } })
    }
    for (const a of topKeys(hist, total, RANGE_1_7, (k) => mapRotate(k, true), 2)) {
      out.push({ opId: 'rotate-left', args: { amount: a } })
    }
    for (const a of topKeys(hist, total, RANGE_1_7, (k) => mapRotate(k, false), 2)) {
      out.push({ opId: 'rotate-right', args: { amount: a } })
    }
  }
  // last, so that when it lands on the same bytes as a named key the named key
  // is the one the user sees.
  out.push({ opId: 'xor-brute', args: {} })
  return out
}

function describe(op: Operation, args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k} ${String(v)}`)
  return parts.length ? `${op.label}, ${parts.join(', ')}` : op.label
}

/**
 * Returns the operations worth trying, deepest and most convincing first. A
 * hit at depth 1 only makes sense applied after the depth 0 hit above it.
 */
export function magic(
  input: Uint8Array,
  opts?: { intensive?: boolean; maxDepth?: number },
): MagicHit[] {
  const intensive = opts?.intensive ?? false
  const maxDepth = Math.max(1, Math.min(6, opts?.maxDepth ?? 3))
  const root = input.length > SPECULATE_BYTES ? input.subarray(0, SPECULATE_BYTES) : input
  if (root.length === 0) return []

  const rootQuality = quality(root)
  const nodes: Node[] = []
  const seen = new Set<string>([fingerprint(root)])
  let frontier: Array<{ index: number; bytes: Uint8Array; quality: number }> = [
    { index: -1, bytes: root, quality: rootQuality },
  ]

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const produced: Array<{ node: Node; index: number }> = []

    for (const branch of frontier) {
      for (const cand of candidatesFor(branch.bytes, intensive)) {
        const op = operation(cand.opId)
        if (!op) continue
        let bytes: Uint8Array
        try {
          bytes = op.run(branch.bytes, cand.args)
        } catch {
          continue
        }
        if (bytes.length === 0 || sameBytes(bytes, branch.bytes)) continue
        const print = fingerprint(bytes)
        if (seen.has(print)) continue
        seen.add(print)

        const q = quality(bytes)
        if (!DECODERS.has(cand.opId) && q - branch.quality <= 0.06) continue

        // a handful of bytes will look like anything, so short results carry
        // less weight even when they read cleanly.
        const weight = Math.min(1, bytes.length / 8) * (1 - depth * 0.02)
        const node: Node = {
          parent: branch.index,
          opId: cand.opId,
          args: cand.args,
          label: describe(op, cand.args),
          bytes,
          depth,
          quality: q,
          confidence: clamp01(0.6 * q + 0.6 * Math.max(0, q - rootQuality)) * weight,
        }
        nodes.push(node)
        produced.push({ node, index: nodes.length - 1 })
      }
    }

    const structural = produced
      .filter((p) => DECODERS.has(p.node.opId))
      .sort((a, b) => b.node.quality - a.node.quality)
      .slice(0, STRUCTURAL_KEEP)
    const ranked = produced
      .filter((p) => !DECODERS.has(p.node.opId))
      .sort((a, b) => b.node.quality - a.node.quality)
      .slice(0, BEAM)

    frontier = [...structural, ...ranked].map((p) => ({
      index: p.index,
      bytes: p.node.bytes,
      quality: p.node.quality,
    }))
  }

  // a decode step that unlocks a readable result inherits that result's worth,
  // otherwise the necessary from-hex would rank below every dead end.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (node.parent < 0) continue
    const parent = nodes[node.parent]
    const inherited = node.confidence * 0.95
    if (inherited > parent.confidence) parent.confidence = inherited
  }

  const hits = new Map<string, MagicHit>()
  for (const node of nodes) {
    const key = `${node.opId}|${JSON.stringify(node.args)}`
    const hit: MagicHit = {
      opId: node.opId,
      args: node.args,
      label: node.label,
      confidence: node.confidence,
      preview: preview(node.bytes),
      depth: node.depth,
    }
    const existing = hits.get(key)
    if (!existing || hit.confidence > existing.confidence) hits.set(key, hit)
  }

  return [...hits.values()]
    .filter((h) => h.confidence > 0.05)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_HITS)
}

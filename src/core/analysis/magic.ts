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
  profileBytes,
  shannonEntropy,
} from '@/core/analysis/metrics'
import type { TextProfile } from '@/core/analysis/metrics'
import { bake, makeStep, operation } from '@/core/analysis/recipe'
import type { RecipeStep } from '@/core/analysis/recipe'

/** One reason a result scored, in the words the panel shows. */
export interface MagicSignal {
  id: string
  label: string
}

export interface MagicHit {
  /** The last operation of the chain. */
  opId: string
  args: Record<string, unknown>
  /** Every step from the searched input to this result, in order. */
  chain: RecipeStep[]
  /** The last step alone, for example "rot13". */
  label: string
  /** The whole chain, for example "xor a5, then rot13". */
  chainLabel: string
  confidence: number
  /** Printable rendering of the result, truncated. */
  preview: string
  signals: MagicSignal[]
  depth: number
}

export interface MagicSolution {
  steps: RecipeStep[]
  /** "xor a5, then rot13". */
  sentence: string
  /** The full input run through the steps, not the speculation window. */
  output: Uint8Array
  preview: string
  signals: MagicSignal[]
  confidence: number
}

interface Candidate {
  opId: string
  args: Record<string, unknown>
}

interface Node {
  parent: number
  opId: string
  args: Record<string, unknown>
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
/** Each extra step has to earn its place, so shorter chains win close calls. */
const DEPTH_COST = 0.015
/** Below either of these, one press applies nothing and says so. */
const MIN_SOLVE_CONFIDENCE = 0.4
const MIN_SOLVE_QUALITY = 0.45

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

// ---------------------------------------------------------------------------
// plain words for what happened
// ---------------------------------------------------------------------------

/** One step, short enough to read inline. */
export function describeStep(step: RecipeStep): string {
  const args = step.args ?? {}
  const text = (key: string): string => {
    const v = args[key]
    return v === undefined || v === null ? '' : String(v)
  }
  switch (step.opId) {
    case 'xor':
      return `xor ${text('key')}`.trim()
    case 'xor-brute':
      return 'xor brute force'
    case 'caesar':
      return `caesar ${text('shift')}`.trim()
    case 'vigenere':
      return `vigenere ${text('key')}`.trim()
    case 'rotate-left':
      return `rotate left ${text('amount')}`.trim()
    case 'rotate-right':
      return `rotate right ${text('amount')}`.trim()
    case 'take-slice':
      return `slice from ${text('start') || '0'}`
    case 'drop-bytes':
      return `drop ${text('count') || '0'} bytes from the ${text('from') || 'start'}`
    default:
      return operation(step.opId)?.label ?? step.opId
  }
}

/** The whole chain as a sentence: "xor a5, then rot13". */
export function describeChain(steps: RecipeStep[]): string {
  return steps.map(describeStep).join(', then ')
}

/** Which measures moved, in the order a reader cares about them. */
export function signalsFor(before: TextProfile, after: TextProfile): MagicSignal[] {
  const out: MagicSignal[] = []
  if (after.printable >= 0.995 && before.printable < 0.995) {
    out.push({ id: 'all-printable', label: 'every byte prints' })
  } else if (after.printable > before.printable + 0.08) {
    out.push({ id: 'printable', label: 'more printable' })
  }
  if (after.english >= 0.3) out.push({ id: 'english', label: 'looks like english' })
  if (after.words > before.words) out.push({ id: 'words', label: 'known words' })
  if (after.entropy < before.entropy - 0.2) out.push({ id: 'entropy', label: 'entropy dropped' })
  const spaced = (p: TextProfile): boolean => p.spaceRatio >= 0.05 && p.spaceRatio <= 0.3
  if (spaced(after) && !spaced(before)) out.push({ id: 'spacing', label: 'word spacing' })
  if (after.utf8 === 'utf8') out.push({ id: 'utf8', label: 'valid utf8' })
  if (out.length === 0) out.push({ id: 'quality', label: 'closer to text' })
  return out
}

// ---------------------------------------------------------------------------
// the search
// ---------------------------------------------------------------------------

interface Search {
  nodes: Node[]
  root: Uint8Array
  rootQuality: number
  rootProfile: TextProfile
}

function confidenceOf(q: number, rootQuality: number, length: number, depth: number): number {
  // a handful of bytes will look like anything, so short results carry less
  // weight even when they read cleanly.
  const weight = Math.min(1, length / 8) * (1 - depth * 0.02)
  return clamp01(0.6 * q + 0.6 * Math.max(0, q - rootQuality)) * weight
}

function search(input: Uint8Array, intensive: boolean, maxDepth: number): Search {
  const root = input.length > SPECULATE_BYTES ? input.subarray(0, SPECULATE_BYTES) : input
  const rootQuality = quality(root)
  const nodes: Node[] = []
  if (root.length === 0) {
    return { nodes, root, rootQuality, rootProfile: profileBytes(root) }
  }

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

        const node: Node = {
          parent: branch.index,
          opId: cand.opId,
          args: cand.args,
          bytes,
          depth,
          quality: q,
          confidence: confidenceOf(q, rootQuality, bytes.length, depth),
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

  return { nodes, root, rootQuality, rootProfile: profileBytes(root) }
}

function chainOf(nodes: Node[], index: number): RecipeStep[] {
  const steps: RecipeStep[] = []
  for (let i = index; i >= 0; i = nodes[i].parent) {
    steps.unshift(makeStep(nodes[i].opId, nodes[i].args))
  }
  return steps
}

function chainKey(steps: RecipeStep[]): string {
  return steps.map((s) => `${s.opId}:${JSON.stringify(s.args)}`).join('>')
}

/**
 * Every chain worth trying, most convincing first. A chain is applied whole:
 * the decode step that unlocks a readable result travels with the step that
 * reads it, so nothing in the list depends on the entry above it.
 */
export function magic(
  input: Uint8Array,
  opts?: { intensive?: boolean; maxDepth?: number },
): MagicHit[] {
  const intensive = opts?.intensive ?? false
  const maxDepth = Math.max(1, Math.min(6, opts?.maxDepth ?? 3))
  const found = search(input, intensive, maxDepth)
  if (found.nodes.length === 0) return []

  interface Entry {
    index: number
    key: string
    chain: RecipeStep[]
    confidence: number
  }
  const byKey = new Map<string, Entry>()
  for (let i = 0; i < found.nodes.length; i++) {
    const node = found.nodes[i]
    if (node.confidence <= 0.05) continue
    const chain = chainOf(found.nodes, i)
    const key = chainKey(chain)
    const existing = byKey.get(key)
    if (!existing || node.confidence > existing.confidence) {
      byKey.set(key, { index: i, key, chain, confidence: node.confidence })
    }
  }

  const ordered = [...byKey.values()].sort((a, b) => b.confidence - a.confidence)
  const kept: Entry[] = []
  for (const entry of ordered) {
    // a chain that another kept chain extends is already on offer inside it.
    if (kept.some((k) => k.key.startsWith(`${entry.key}>`))) continue
    kept.push(entry)
    if (kept.length >= MAX_HITS) break
  }

  return kept.map((entry) => {
    const node = found.nodes[entry.index]
    const last = entry.chain[entry.chain.length - 1]
    return {
      opId: node.opId,
      args: node.args,
      chain: entry.chain,
      label: describeStep(last),
      chainLabel: describeChain(entry.chain),
      confidence: node.confidence,
      preview: preview(node.bytes),
      signals: signalsFor(found.rootProfile, profileBytes(node.bytes)),
      depth: node.depth,
    }
  })
}

/**
 * One press. Searches the intensive keyspaces, takes the chain whose output
 * reads best, and trims trailing steps that stopped adding anything. Returns
 * null when nothing beat the input it was handed.
 */
export function solve(input: Uint8Array, opts?: { maxDepth?: number }): MagicSolution | null {
  const maxDepth = Math.max(1, Math.min(6, opts?.maxDepth ?? 3))
  const found = search(input, true, maxDepth)
  if (found.nodes.length === 0) return null

  let best = -1
  let bestScore = MIN_SOLVE_CONFIDENCE
  for (let i = 0; i < found.nodes.length; i++) {
    const node = found.nodes[i]
    const score = node.confidence - DEPTH_COST * node.depth
    if (
      score > bestScore &&
      node.quality >= MIN_SOLVE_QUALITY &&
      node.quality > found.rootQuality + 0.03
    ) {
      bestScore = score
      best = i
    }
  }
  if (best < 0) return null

  const full = chainOf(found.nodes, best)
  let cut = full.length
  let cutScore = -Infinity
  for (let n = 1; n <= full.length; n++) {
    const partial = bake(found.root, full.slice(0, n))
    if (partial.error) break
    const q = quality(partial.output)
    const score = confidenceOf(q, found.rootQuality, partial.output.length, n - 1) - DEPTH_COST * n
    if (score > cutScore + 1e-9) {
      cutScore = score
      cut = n
    }
  }

  let steps = full.slice(0, cut)
  const baked = bake(input, steps)
  if (baked.error) steps = steps.slice(0, baked.perStep.length)
  if (steps.length === 0) return null

  const output = baked.output
  const window = output.length > SPECULATE_BYTES ? output.subarray(0, SPECULATE_BYTES) : output
  const q = quality(window)
  return {
    steps,
    sentence: describeChain(steps),
    output,
    preview: preview(output),
    signals: signalsFor(found.rootProfile, profileBytes(window)),
    confidence: confidenceOf(q, found.rootQuality, output.length, steps.length - 1),
  }
}

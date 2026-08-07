/**
 * Measurements the playbooks make on captured signals.
 *
 * Everything here works on interleaved IQ at a known sample rate, or on the
 * fftshifted magnitude bins the bus already carries. No device is named and no
 * protocol is assumed beyond two level keying, which is what cheap ISM gear
 * uses.
 */

export interface LevelSplit {
  threshold: number
  /** Between class variance over total variance, 0 to 1. */
  separation: number
  low: number
  high: number
}

export interface ModulationEstimate {
  kind: 'ook' | 'fsk' | 'unclear'
  /** 0 to 1. How much better the winner fits than the other one. */
  confidence: number
  amplitudeSplit: number
  freqSplit: number
  amplitudeVariance: number
  freqSpreadHz: number
  note: string
}

export interface BitSlice {
  /** One entry per symbol, 0 or 1. */
  bits: Uint8Array
  symbolRateHz: number
  symbolSamples: number
  runs: number
}

export interface RepeatFind {
  period: number
  repeats: number
  /** Fraction of samples that matched at that period. */
  ratio: number
}

export interface PreambleFind {
  /** The repeating unit, written as bits. */
  pattern: string
  repeats: number
  bitCount: number
}

export interface ParsedFrame {
  modulation: ModulationEstimate
  bits: Uint8Array
  bitLength: number
  bytes: Uint8Array
  symbolRateHz: number
  repeats: number
  preamble: PreambleFind | null
}

export interface CarrierPeak {
  hz: number
  db: number
  /** How far the peak stands above the noise floor. */
  snrDb: number
  binIndex: number
}

// ---------------------------------------------------------------------------
// basics
// ---------------------------------------------------------------------------

export function magnitudes(iq: Float32Array): Float32Array {
  const n = iq.length >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.hypot(iq[i * 2], iq[i * 2 + 1])
  return out
}

/** Sample to sample phase step turned into Hz. Length is one less than input. */
export function instantaneousFreq(iq: Float32Array, sampleRate: number): Float32Array {
  const n = iq.length >> 1
  const out = new Float32Array(Math.max(0, n - 1))
  const scale = sampleRate / (2 * Math.PI)
  for (let i = 1; i < n; i++) {
    const ri = iq[i * 2]
    const rq = iq[i * 2 + 1]
    const pi = iq[(i - 1) * 2]
    const pq = iq[(i - 1) * 2 + 1]
    const di = ri * pi + rq * pq
    const dq = rq * pi - ri * pq
    out[i - 1] = Math.atan2(dq, di) * scale
  }
  return out
}

function mean(v: ArrayLike<number>): number {
  if (!v.length) return 0
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]
  return s / v.length
}

function variance(v: ArrayLike<number>, m = mean(v)): number {
  if (v.length < 2) return 0
  let s = 0
  for (let i = 0; i < v.length; i++) {
    const d = v[i] - m
    s += d * d
  }
  return s / v.length
}

/**
 * Splits a set of values into two clusters and reports how cleanly it went.
 * A histogram search over thresholds, the same idea as image thresholding.
 */
export function twoLevelSplit(values: ArrayLike<number>, bins = 64): LevelSplit {
  const empty: LevelSplit = { threshold: 0, separation: 0, low: 0, high: 0 }
  if (values.length < 16) return empty

  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < values.length; i++) {
    if (values[i] < min) min = values[i]
    if (values[i] > max) max = values[i]
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-9) return empty

  const hist = new Float64Array(bins)
  const step = (max - min) / bins
  for (let i = 0; i < values.length; i++) {
    const b = Math.min(bins - 1, Math.floor((values[i] - min) / step))
    hist[b]++
  }

  const total = values.length
  const m = mean(values)
  const totalVar = variance(values, m)
  if (totalVar <= 0) return { threshold: m, separation: 0, low: m, high: m }

  let w0 = 0
  let sum0 = 0
  let best = { between: 0, cut: 0, low: m, high: m }
  for (let b = 0; b < bins - 1; b++) {
    const centre = min + (b + 0.5) * step
    w0 += hist[b]
    sum0 += hist[b] * centre
    if (w0 === 0 || w0 === total) continue
    const w1 = total - w0
    const m0 = sum0 / w0
    // the running total of the whole set, reconstructed from the mean.
    const m1 = (m * total - sum0) / w1
    const between = (w0 / total) * (w1 / total) * (m0 - m1) * (m0 - m1)
    if (between > best.between) {
      best = { between, cut: min + (b + 1) * step, low: m0, high: m1 }
    }
  }

  return {
    threshold: best.cut,
    separation: Math.max(0, Math.min(1, best.between / totalVar)),
    low: best.low,
    high: best.high,
  }
}

// ---------------------------------------------------------------------------
// modulation
// ---------------------------------------------------------------------------

/**
 * Decides between on off keying and frequency shift keying.
 *
 * Amplitude keying leaves the amplitude sitting in two clusters and the
 * instantaneous frequency as noise. Frequency keying does the opposite: a
 * steady envelope with the frequency in two clusters. Both are scored the same
 * way so the numbers are comparable.
 */
export function estimateModulation(iq: Float32Array, sampleRate: number): ModulationEstimate {
  const mags = magnitudes(iq)
  const magMean = mean(mags)
  const amplitudeVariance = magMean > 0 ? variance(mags, magMean) / (magMean * magMean) : 0
  const ampSplit = twoLevelSplit(mags)

  // phase is meaningless where there is no carrier, so only strong samples
  // contribute to the frequency numbers.
  const freqAll = instantaneousFreq(iq, sampleRate)
  const gate = magMean * 0.6
  const strong: number[] = []
  for (let i = 0; i < freqAll.length; i++) {
    if (mags[i + 1] > gate) strong.push(freqAll[i])
  }
  const freqSplit = twoLevelSplit(strong)
  const freqSpreadHz = Math.sqrt(variance(strong))

  const a = ampSplit.separation
  const f = freqSplit.separation
  const winner = Math.max(a, f)
  const loser = Math.min(a, f)
  const margin = winner > 0 ? (winner - loser) / (winner + loser + 1e-9) : 0

  if (winner < 0.2 || strong.length < 32) {
    return {
      kind: 'unclear',
      confidence: Math.max(0, Math.min(1, winner)),
      amplitudeSplit: a,
      freqSplit: f,
      amplitudeVariance,
      freqSpreadHz,
      note: 'neither the amplitude nor the frequency falls into two clean levels. this may be noise, a wider mode than two level keying, or too short a capture.',
    }
  }

  const kind = a >= f ? 'ook' : 'fsk'
  return {
    kind,
    confidence: Math.max(0, Math.min(1, winner * (0.6 + 0.4 * margin))),
    amplitudeSplit: a,
    freqSplit: f,
    amplitudeVariance,
    freqSpreadHz,
    note:
      kind === 'ook'
        ? 'the amplitude sits at two levels while the frequency stays put, which is the carrier being switched on and off.'
        : 'the envelope holds steady while the frequency sits at two values, which is the carrier being shifted between two tones.',
  }
}

// ---------------------------------------------------------------------------
// bits
// ---------------------------------------------------------------------------

function median3(levels: Uint8Array): Uint8Array {
  if (levels.length < 3) return levels
  const out = new Uint8Array(levels.length)
  out[0] = levels[0]
  out[levels.length - 1] = levels[levels.length - 1]
  for (let i = 1; i < levels.length - 1; i++) {
    out[i] = levels[i - 1] + levels[i] + levels[i + 1] >= 2 ? 1 : 0
  }
  return out
}

/** Slices a burst into symbols, estimating the symbol length from the runs. */
export function sliceToBits(
  iq: Float32Array,
  sampleRate: number,
  kind: 'ook' | 'fsk',
): BitSlice | null {
  const mags = magnitudes(iq)
  let levels: Uint8Array

  if (kind === 'fsk') {
    const freqs = instantaneousFreq(iq, sampleRate)
    if (freqs.length < 64) return null
    const split = twoLevelSplit(freqs)
    levels = new Uint8Array(freqs.length)
    for (let i = 0; i < freqs.length; i++) levels[i] = freqs[i] >= split.threshold ? 1 : 0
  } else {
    const split = twoLevelSplit(mags)
    if (split.separation <= 0) return null
    levels = new Uint8Array(mags.length)
    for (let i = 0; i < mags.length; i++) levels[i] = mags[i] >= split.threshold ? 1 : 0
  }

  levels = median3(levels)

  const runs: Array<{ level: number; len: number }> = []
  let current = levels[0]
  let len = 1
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] === current) {
      len++
    } else {
      runs.push({ level: current, len })
      current = levels[i]
      len = 1
    }
  }
  runs.push({ level: current, len })
  if (runs.length < 4) return null

  const lengths = runs
    .map((r) => r.len)
    .filter((l) => l >= 2)
    .sort((x, y) => x - y)
  if (!lengths.length) return null
  const unit = Math.max(2, lengths[Math.floor(lengths.length * 0.1)])

  const bits: number[] = []
  for (const r of runs) {
    const count = Math.max(1, Math.round(r.len / unit))
    if (r.len < unit / 2) continue
    for (let i = 0; i < count && bits.length < 4096; i++) bits.push(r.level)
  }
  if (bits.length < 8) return null

  return {
    bits: Uint8Array.from(bits),
    symbolRateHz: sampleRate / unit,
    symbolSamples: unit,
    runs: runs.length,
  }
}

/** The shortest period the bit stream repeats at, which is one frame. */
export function findRepeat(bits: Uint8Array): RepeatFind | null {
  const n = bits.length
  let best: RepeatFind | null = null
  for (let p = 4; p <= Math.floor(n / 2); p++) {
    let hits = 0
    const compared = n - p
    for (let i = 0; i < compared; i++) if (bits[i] === bits[i + p]) hits++
    const ratio = hits / compared
    if (ratio >= 0.9) {
      best = { period: p, repeats: Math.floor(n / p), ratio }
      break
    }
  }
  return best
}

/** A short pattern repeated at the head of the stream, which is the preamble. */
export function findPreamble(bits: Uint8Array): PreambleFind | null {
  let best: PreambleFind | null = null
  for (let p = 1; p <= Math.min(16, bits.length >> 2); p++) {
    let repeats = 0
    for (let start = 0; start + p <= bits.length; start += p) {
      let same = true
      for (let i = 0; i < p; i++) {
        if (bits[start + i] !== bits[i]) {
          same = false
          break
        }
      }
      if (!same) break
      repeats++
    }
    if (repeats >= 3) {
      const found: PreambleFind = {
        pattern: [...bits.slice(0, p)].join(''),
        repeats,
        bitCount: repeats * p,
      }
      if (!best || found.bitCount > best.bitCount) best = found
    }
  }
  return best
}

/** MSB first, the last byte padded with zeros. */
export function packBits(bits: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8))
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7)
  }
  return out
}

export function bitsToString(bits: Uint8Array, max = 96): string {
  const head = [...bits.slice(0, max)].join('')
  return bits.length > max ? `${head}...` : head
}

/** How much this chunk looks like a burst rather than idle noise. */
export function burstScore(iq: Float32Array): number {
  const mags = magnitudes(iq)
  if (!mags.length) return 0
  const m = mean(mags)
  let peak = 0
  for (let i = 0; i < mags.length; i++) if (mags[i] > peak) peak = mags[i]
  return peak * (peak / (m + 1e-9))
}

/** The whole parse: modulation, symbols, one frame, bytes. */
export function parseBurst(iq: Float32Array, sampleRate: number): ParsedFrame | null {
  const modulation = estimateModulation(iq, sampleRate)
  const kind = modulation.kind === 'fsk' ? 'fsk' : 'ook'
  const slice = sliceToBits(iq, sampleRate, kind)
  if (!slice) return null

  const repeat = findRepeat(slice.bits)
  const frameBits = repeat ? slice.bits.slice(0, repeat.period) : slice.bits
  return {
    modulation,
    bits: frameBits,
    bitLength: frameBits.length,
    bytes: packBits(frameBits),
    symbolRateHz: slice.symbolRateHz,
    repeats: repeat?.repeats ?? 1,
    preamble: findPreamble(frameBits),
  }
}

// ---------------------------------------------------------------------------
// spectrum
// ---------------------------------------------------------------------------

export function averageBins(frames: Float32Array[]): Float32Array | null {
  if (!frames.length) return null
  const n = frames[0].length
  const out = new Float32Array(n)
  let used = 0
  for (const f of frames) {
    if (f.length !== n) continue
    for (let i = 0; i < n; i++) out[i] += f[i]
    used++
  }
  if (!used) return null
  for (let i = 0; i < n; i++) out[i] /= used
  return out
}

/**
 * The loudest carrier in an fftshifted frame. The middle bins are skipped
 * because a receiver's own dc offset lands there and is not a signal.
 */
export function strongestCarrier(
  bins: Float32Array,
  centerHz: number,
  sampleRate: number,
): CarrierPeak | null {
  const n = bins.length
  if (n < 16) return null
  const sorted = Float32Array.from(bins).sort()
  const floorDb = sorted[Math.floor(n / 2)]
  const guard = Math.max(2, Math.round(n * 0.01))

  let bestIndex = -1
  let bestDb = -Infinity
  for (let i = 0; i < n; i++) {
    if (Math.abs(i - n / 2) <= guard) continue
    if (bins[i] > bestDb) {
      bestDb = bins[i]
      bestIndex = i
    }
  }
  if (bestIndex < 0) return null

  return {
    hz: centerHz + ((bestIndex - n / 2) / n) * sampleRate,
    db: bestDb,
    snrDb: bestDb - floorDb,
    binIndex: bestIndex,
  }
}

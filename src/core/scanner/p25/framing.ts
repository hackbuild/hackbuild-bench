/**
 * P25 phase 1 framing, both ways: the frame sync, the status dibits, the
 * half rate trellis and its interleave, and the TSBK crc.
 *
 * The receiver reads frames with these, and the transmitter in
 * `modulate.ts` builds them, so a test of one checks the other. The tables
 * follow TIA-102.BAAA as implemented by op25 and sdrtrunk.
 */

/** 0x5575F5FF77FF as dibits. Only the outer two levels appear in it. */
export const SYNC = [1, 1, 1, 1, 1, 3, 1, 1, 3, 3, 1, 1, 3, 3, 3, 3, 1, 3, 1, 3, 3, 3, 3, 3]

/** Dibit to symbol level, in units where the outer symbols are +-3. */
export const LEVEL = [1, 3, -1, -3]

/** The dibit a symbol level slices to. */
export function dibitOf(level: number): number {
  return level > 2 ? 1 : level > 0 ? 0 : level > -2 ? 2 : 3
}

export const NID_DIBITS = 32
export const TSBK_DIBITS = 98
export const MAX_TSBKS = 3

/** Transmitted dibits from the first sync dibit to the first block dibit, status included. */
export const UNIT_HEAD_DIBITS = SYNC.length + NID_DIBITS + 1

export const DUID = {
  HDU: 0x0,
  TDU: 0x3,
  LDU1: 0x5,
  TSDU: 0x7,
  LDU2: 0xa,
  PDU: 0xc,
  TDULC: 0xf,
} as const

/**
 * Half rate trellis: the four bit value the encoder transmits, indexed by
 * [state][input dibit], where the next state is the input.
 *
 * op25 p25p1_fdma.cc next_words, sdrtrunk P25_1_2_Node TRANSITION_MATRIX.
 */
const TRELLIS_HALF = [
  [2, 12, 1, 15],
  [14, 0, 13, 3],
  [9, 7, 10, 4],
  [5, 11, 6, 8],
]

/**
 * Gather order for the 98 dibits of a half rate block. The references hold
 * 196 bit indices; every group of four is two adjacent dibits, so they reduce
 * to these 98 entries without loss.
 *
 * op25 p25p1_fdma.cc deinterleave_tb, sdrtrunk P25P1Interleave DATA_INTERLEAVE.
 */
const DEINTERLEAVE = [
  0, 1, 26, 27, 50, 51, 74, 75, 2, 3, 28, 29, 52, 53, 76, 77, 4, 5, 30, 31, 54, 55, 78,
  79, 6, 7, 32, 33, 56, 57, 80, 81, 8, 9, 34, 35, 58, 59, 82, 83, 10, 11, 36, 37, 60, 61,
  84, 85, 12, 13, 38, 39, 62, 63, 86, 87, 14, 15, 40, 41, 64, 65, 88, 89, 16, 17, 42, 43,
  66, 67, 90, 91, 18, 19, 44, 45, 68, 69, 92, 93, 20, 21, 46, 47, 70, 71, 94, 95, 22, 23,
  48, 49, 72, 73, 96, 97, 24, 25,
]

/**
 * A status dibit follows every 35 information dibits, counted from the first
 * dibit of the frame sync, so transmitted positions 35, 71, 107 and on carry
 * no frame content.
 *
 * TIA-102.BAAA-A section 8.2, op25 p25p1_fdma.cc process_blocks.
 */
export function isStatusDibit(pos: number): boolean {
  return pos >= 35 && (pos - 35) % 36 === 0
}

function popcount4(v: number): number {
  return (v & 1) + ((v >> 1) & 1) + ((v >> 2) & 1) + ((v >> 3) & 1)
}

/**
 * Viterbi over the half rate trellis. 98 dibits in, 12 octets out.
 *
 * Each pair of received dibits is one four bit constellation point. Four
 * states, one step per point, branch metric is the Hamming distance to what
 * the encoder would have produced.
 */
export function trellisHalfDecode(dibits: ArrayLike<number>): Uint8Array | null {
  if (dibits.length < TSBK_DIBITS) return null

  const deint = new Int8Array(TSBK_DIBITS)
  for (let i = 0; i < TSBK_DIBITS; i++) deint[i] = dibits[DEINTERLEAVE[i]]

  const steps = TSBK_DIBITS / 2
  const cost = [0, 1e9, 1e9, 1e9]
  const back = new Uint8Array(steps * 4)

  for (let step = 0; step < steps; step++) {
    // two dibits make the four bit point, first dibit is the high pair.
    const point = ((deint[step * 2] & 3) << 2) | (deint[step * 2 + 1] & 3)
    const next = [1e9, 1e9, 1e9, 1e9]
    for (let from = 0; from < 4; from++) {
      if (cost[from] >= 1e9) continue
      for (let input = 0; input < 4; input++) {
        const metric = cost[from] + popcount4(TRELLIS_HALF[from][input] ^ point)
        // the next state is the input, which is what makes the traceback easy.
        if (metric < next[input]) {
          next[input] = metric
          back[step * 4 + input] = from
        }
      }
    }
    for (let i = 0; i < 4; i++) cost[i] = next[i]
  }

  // the encoder flushes to state zero, so the survivor ends there.
  let state = 0
  const inputs = new Uint8Array(steps)
  for (let step = steps - 1; step >= 0; step--) {
    inputs[step] = state
    state = back[step * 4 + state]
  }

  // the last input is the flush, the other 48 dibits are the 12 octets.
  const out = new Uint8Array(12)
  for (let i = 0; i < 48; i++) {
    out[i >> 2] = ((out[i >> 2] << 2) | (inputs[i] & 3)) & 0xff
  }
  return out
}

/** 12 octets to the 98 interleaved dibits a block is sent as. */
export function trellisHalfEncode(octets: Uint8Array): number[] {
  const inputs: number[] = []
  for (let i = 0; i < 12; i++) for (let s = 6; s >= 0; s -= 2) inputs.push((octets[i] >> s) & 3)
  inputs.push(0)
  const coded = new Array<number>(TSBK_DIBITS)
  let state = 0
  for (let step = 0; step < inputs.length; step++) {
    const point = TRELLIS_HALF[state][inputs[step]]
    coded[step * 2] = (point >> 2) & 3
    coded[step * 2 + 1] = point & 3
    state = inputs[step]
  }
  const sent = new Array<number>(TSBK_DIBITS)
  for (let i = 0; i < TSBK_DIBITS; i++) sent[DEINTERLEAVE[i]] = coded[i]
  return sent
}

/**
 * TSBK crc: polynomial 0x1021, msb first, no reflection, seed 0, over the
 * first ten octets, inverted into octets 10 and 11.
 *
 * op25 p25p1_fdma.cc crc16, sdrtrunk CRCP25 CCITT_80_CHECKSUMS.
 */
export function tsbkCrc(octets: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < 10; i++) {
    crc ^= octets[i] << 8
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return ~crc & 0xffff
}

export function tsbkCrcOk(octets: Uint8Array): boolean {
  const crc = tsbkCrc(octets)
  return octets[10] === ((crc >> 8) & 0xff) && octets[11] === (crc & 0xff)
}

/**
 * The dibits of one TSDU: sync, NID, and up to three TSBKs, with the status
 * dibits in place. The NID's BCH parity is left zero, which the receiver
 * here does not read.
 */
export function buildTsdu(nac: number, tsbks: Uint8Array[]): number[] {
  const content: number[] = [...SYNC]
  const nid = ((nac & 0xfff) << 4) | DUID.TSDU
  for (let s = 14; s >= 0; s -= 2) content.push((nid >> s) & 3)
  for (let i = 8; i < NID_DIBITS; i++) content.push(0)
  tsbks.forEach((t, k) => {
    const o = t.slice(0, 12)
    o[0] = (o[0] & 0x7f) | (k === tsbks.length - 1 ? 0x80 : 0)
    const crc = tsbkCrc(o)
    o[10] = (crc >> 8) & 0xff
    o[11] = crc & 0xff
    content.push(...trellisHalfEncode(o))
  })
  const out: number[] = []
  let c = 0
  while (c < content.length) {
    if (isStatusDibit(out.length)) out.push(2)
    else out.push(content[c++])
  }
  return out
}

/**
 * The ACARS block layer, after the bits are recovered.
 *
 * A block is SYN SYN SOH, then mode, a seven character registration, ack,
 * a two character label, the block id, STX or ETX, the text, ETX or ETB, and
 * a CRC-16 over everything from mode to the terminator. Every character
 * carries odd parity in bit 7.
 *
 * The check and the repair follow acarsdec 3.7 (Thierry Leconte, LGPL-2), so
 * a block either decoder accepts reads the same in both.
 */

import { labelName } from './labels'

export const SYN = 0x16
export const SOH = 0x01
export const STX = 0x02
export const ETX = 0x83
export const ETB = 0x97
export const DLE = 0x7f
const NAK = 0x15

/** Parity errors past this are dropped rather than repaired. */
export const MAX_PARITY_ERRORS = 3
/** Longest text acarsdec collects before giving up on a block. */
export const MAX_BLOCK = 240
/** Mode, registration, ack, label, block id and STX or ETX. */
const HEADER = 13

const CRC_TABLE = (() => {
  const t = new Uint16Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let b = 0; b < 8; b++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1
    t[i] = c
  }
  return t
})()

export function crcUpdate(crc: number, byte: number): number {
  return (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
}

/**
 * The crc a single flipped bit leaves behind, indexed bit plus eight times
 * the byte's distance from the end, counting the two crc bytes as 0 and 1.
 */
const SYNDROME = (() => {
  const rows = MAX_BLOCK + 8
  const s = new Uint16Array(rows * 8)
  for (let bit = 0; bit < 8; bit++) {
    let crc = crcUpdate(0, 1 << bit)
    s[bit] = crc
    for (let k = 1; k < rows; k++) {
      crc = crcUpdate(crc, 0)
      s[bit + 8 * k] = crc
    }
  }
  return s
})()

function oddParity(b: number): boolean {
  b ^= b >> 4
  b ^= b >> 2
  b ^= b >> 1
  return (b & 1) === 1
}

function inCrcBytes(crc: number): boolean {
  for (let i = 0; i < 16; i++) if (SYNDROME[i] === crc) return true
  return false
}

function fixParity(txt: Uint8Array, len: number, crc: number, pr: number[], at: number): boolean {
  if (at >= pr.length) return crc === 0 || inCrcBytes(crc)
  const pos = pr[at]
  for (let i = 0; i < 8; i++) {
    if (fixParity(txt, len, crc ^ SYNDROME[i + 8 * (len - pos + 1)], pr, at + 1)) {
      txt[pos] ^= 1 << i
      return true
    }
  }
  return false
}

function fixDouble(txt: Uint8Array, len: number, crc: number): boolean {
  if (inCrcBytes(crc)) return true
  for (let k = 0; k < len; k++) {
    const bo = 8 * (len - k + 1)
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        if (i === j) continue
        if ((crc ^ SYNDROME[i + bo] ^ SYNDROME[j + bo]) === 0) {
          txt[k] ^= (1 << i) | (1 << j)
          return true
        }
      }
    }
  }
  return false
}

/** A block straight off the framer, before the check. */
export interface RawBlock {
  /** Characters from mode to the terminator, parity bits still set. */
  txt: Uint8Array
  crc0: number
  crc1: number
  /** Matched filter level in dB over the block. */
  levelDb: number
  /** Sample index on the channel's own clock where the block began. */
  at: number
}

export type CheckResult =
  | { ok: true; bytes: Uint8Array; corrected: number }
  | { ok: false; reason: 'short' | 'parity' | 'crc' }

/**
 * Parity and crc check with acarsdec's repair: up to three parity errors are
 * fixed bit by bit against the crc, and with clean parity a two bit error in
 * one character is tried. Returns the characters with parity stripped.
 */
export function checkBlock(raw: RawBlock): CheckResult {
  const len = raw.txt.length
  if (len < HEADER) return { ok: false, reason: 'short' }
  const txt = raw.txt.slice()
  // byte 12 can only be STX or ETX, so a bit error there costs nothing.
  txt[12] &= ETX | STX
  txt[12] |= ETX & STX

  const pr: number[] = []
  let pn = 0
  for (let i = 0; i < len; i++) {
    if (!oddParity(txt[i])) {
      if (pn < MAX_PARITY_ERRORS) pr.push(i)
      pn++
    }
  }
  if (pn > MAX_PARITY_ERRORS) return { ok: false, reason: 'parity' }

  let crc = 0
  for (let i = 0; i < len; i++) crc = crcUpdate(crc, txt[i])
  crc = crcUpdate(crc, raw.crc0)
  crc = crcUpdate(crc, raw.crc1)

  if (pn) {
    if (!fixParity(txt, len, crc, pr, 0)) return { ok: false, reason: 'crc' }
  } else if (crc && !fixDouble(txt, len, crc)) {
    return { ok: false, reason: 'crc' }
  }

  for (let i = 0; i < len; i++) {
    if (!oddParity(txt[i])) return { ok: false, reason: 'parity' }
    txt[i] &= 0x7f
  }
  return { ok: true, bytes: txt, corrected: pn }
}

export interface AcarsMessage {
  id: string
  /** Index into the decoder's channel list. */
  channel: number
  freqHz: number
  /** Seconds since the decoder started, on the sample clock. */
  atSec: number
  /** Wall clock ms when the block was decoded. */
  wall: number
  levelDb: number
  /** Characters repaired by the parity and crc fix. */
  corrected: number
  mode: string
  /** Aircraft registration with the padding dots removed. */
  registration: string
  /** The ack character, or null for a nak. */
  ack: string | null
  label: string
  labelName: string
  blockId: string
  /** Block ids 0 to 9 are downlinks, from the aircraft. */
  downlink: boolean
  /** Message number, downlinks only. */
  msgNo: string
  /** Flight id, downlinks only. */
  flight: string
  text: string
  /** False when the block ends in ETB and more blocks follow. */
  end: boolean
  /** The block with parity stripped, mode to terminator. */
  bytes: Uint8Array
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = ''
  for (let i = from; i < to; i++) s += String.fromCharCode(bytes[i])
  return s
}

/** Splits a checked block into fields, the way acarsdec's output does. */
export function parseBlock(
  bytes: Uint8Array,
  meta: { channel: number; freqHz: number; atSec: number; levelDb: number; corrected: number },
): AcarsMessage {
  const len = bytes.length
  let k = 0
  const mode = String.fromCharCode(bytes[k++])
  let registration = ''
  for (let i = 0; i < 7; i++, k++) if (bytes[k] !== 0x2e) registration += String.fromCharCode(bytes[k])
  const ackByte = bytes[k++]
  const l0 = String.fromCharCode(bytes[k++])
  const l1b = bytes[k++]
  const label = l0 + (l1b === DLE ? 'd' : String.fromCharCode(l1b))
  const blockId = String.fromCharCode(bytes[k++])
  const bs = bytes[k++]
  const be = bytes[len - 1]
  const downlink = blockId >= '0' && blockId <= '9'

  let msgNo = ''
  let flight = ''
  let text = ''
  if (bs !== (ETX & 0x7f)) {
    if (downlink) {
      for (let i = 0; i < 4 && k < len - 1; i++, k++) msgNo += String.fromCharCode(bytes[k])
      for (let i = 0; i < 6 && k < len - 1; i++, k++) flight += String.fromCharCode(bytes[k])
    }
    text = ascii(bytes, k, len - 1)
  }

  return {
    id: `${meta.channel}-${meta.atSec.toFixed(4)}`,
    channel: meta.channel,
    freqHz: meta.freqHz,
    atSec: meta.atSec,
    wall: Date.now(),
    levelDb: meta.levelDb,
    corrected: meta.corrected,
    mode,
    registration,
    ack: ackByte === NAK ? null : String.fromCharCode(ackByte),
    label,
    labelName: labelName(label),
    blockId,
    downlink,
    msgNo,
    flight,
    text,
    end: be !== (ETB & 0x7f),
    bytes,
  }
}

/**
 * Applies a key the operator holds to a P25 phase 1 voice frame, so an
 * authorised listener can hear a call their agency encrypts.
 *
 * This is the lawful use of a key already in hand, the same as a radio in
 * the system does. It cracks nothing, tries no keys, and reads no key off
 * the air. A call whose key is not in the store stays silent.
 *
 * The keystream placement follows op25 (GPL-3), which follows TIA-102.AAAD.
 * The ciphers are in `ciphers.ts`.
 */

import { adpKeystream, aesOfbKeystream, desOfbKeystream, expandMiTo128 } from './ciphers'

export const ALGID = {
  CLEAR: 0x80,
  DES_OFB: 0x81,
  AES_256: 0x84,
  ADP_RC4: 0xaa,
} as const

export const ALGID_NAME: Record<number, string> = {
  0x80: 'clear',
  0x81: 'des-ofb',
  0x84: 'aes-256',
  0xaa: 'adp (rc4)',
}

/** A key the operator has loaded. The bytes are the raw key, most significant first. */
export interface StoredKey {
  keyId: number
  algid: number
  key: Uint8Array
  label?: string
}

/** How many key bytes each algorithm expects, for validating what is pasted. */
export const KEY_BYTES: Record<number, number> = {
  0x81: 8,
  0x84: 32,
  0xaa: 5,
}

/**
 * Holds the keys an operator has loaded and applies them to voice frames.
 *
 * `begin` sets up a superframe's keystream from its encryption sync.
 * `applyFrame` then XORs the right slice onto each of the nine voice
 * codewords in an LDU.
 */
export class P25Crypto {
  private keys = new Map<number, StoredKey>()
  private keystream: Uint8Array | null = null
  private algid: number = ALGID.CLEAR
  private position = 0

  setKeys(keys: StoredKey[]): void {
    this.keys = new Map(keys.map((k) => [k.keyId, k]))
  }

  hasKey(keyId: number): boolean {
    return this.keys.has(keyId)
  }

  /**
   * Prepares the keystream for a superframe. Returns false when the call is
   * clear, when no matching key is loaded, or when the algorithm is one this
   * build does not carry, in which case the frames are left untouched.
   */
  begin(algid: number, keyId: number, mi: Uint8Array): boolean {
    this.keystream = null
    this.position = 0
    if (algid === ALGID.CLEAR) return false
    const stored = this.keys.get(keyId)
    if (!stored || stored.algid !== algid) return false
    this.algid = algid
    if (algid === ALGID.ADP_RC4) {
      this.keystream = adpKeystream(stored.key, mi)
    } else if (algid === ALGID.DES_OFB) {
      // base offset 8 is the OFB discard round.
      this.keystream = desOfbKeystream(fit(stored.key, 8), mi.subarray(0, 8), 28)
    } else if (algid === ALGID.AES_256) {
      this.keystream = aesOfbKeystream(fit(stored.key, 32), expandMiTo128(mi), 15)
    } else {
      return false
    }
    return true
  }

  /** True once begin has set up a keystream the frames can be read with. */
  get ready(): boolean {
    return this.keystream !== null
  }

  /**
   * XORs the keystream onto one voice codeword, the 11 packed bytes of the
   * 88 bit IMBE parameter data, in place. `ldu2` is true for the second LDU
   * of the superframe.
   */
  applyFrame(pcw: Uint8Array, ldu2: boolean): void {
    const ks = this.keystream
    if (!ks) return
    const base = this.algid === ALGID.ADP_RC4 ? 267 : this.algid === ALGID.AES_256 ? 16 : 8
    const frame = ldu2 ? 101 : 0
    const pos = this.position
    const offset = frame + base + pos * 11 + (pos < 8 ? 0 : 2)
    this.position = (this.position + 1) % 9
    for (let j = 0; j < 11 && offset + j < ks.length; j++) pcw[j] ^= ks[offset + j]
  }
}

/** A key byte array of exactly `n` bytes, left padded or truncated. */
function fit(key: Uint8Array, n: number): Uint8Array {
  if (key.length === n) return key
  const out = new Uint8Array(n)
  if (key.length < n) out.set(key, n - key.length)
  else out.set(key.subarray(0, n))
  return out
}

/** Parses a hex string into key bytes, or null when it is not clean hex. */
export function parseKeyHex(text: string): Uint8Array | null {
  const clean = text.replace(/[\s:]/g, '')
  if (!clean || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** Packs 88 parameter bits (0/1) into 11 bytes, and back, for the XOR. */
export function packBits(bits: Int8Array | number[]): Uint8Array {
  const out = new Uint8Array(11)
  for (let i = 0; i < 88; i++) out[i >> 3] |= (bits[i] & 1) << (7 - (i & 7))
  return out
}
export function unpackBits(bytes: Uint8Array, into: Int8Array): void {
  for (let i = 0; i < 88; i++) into[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1
}

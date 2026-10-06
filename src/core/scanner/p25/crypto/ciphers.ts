/**
 * The three ciphers P25 phase 1 voice uses, as keystream generators: ADP
 * (RC4), DES in OFB, and AES-256 in OFB. Each is a published standard, and
 * each turns a key and a message indicator into a keystream that is XORed
 * onto the voice bits.
 *
 * These apply a key the operator already holds. They crack nothing and
 * generate no keys. Ported from the TIA-102 standard and checked against the
 * published test vectors for each cipher in `ciphers.test`.
 */

// ---------------------------------------------------------------------------
// RC4, for ADP (ALGID 0xAA)
// ---------------------------------------------------------------------------

/** RC4 keystream from a key, dropping nothing. The caller slices what it needs. */
export function rc4(key: Uint8Array, length: number): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  const out = new Uint8Array(length)
  let a = 0
  let b = 0
  for (let k = 0; k < length; k++) {
    a = (a + 1) & 0xff
    b = (b + s[a]) & 0xff
    ;[s[a], s[b]] = [s[b], s[a]]
    out[k] = s[(s[a] + s[b]) & 0xff]
  }
  return out
}

/** ADP keystream: up to 5 key bytes, left padded, then the 8 byte MI. 469 bytes. */
export function adpKeystream(key: Uint8Array, mi: Uint8Array): Uint8Array {
  const adpKey = new Uint8Array(13)
  const take = Math.min(5, key.length)
  adpKey.set(key.subarray(0, take), 5 - take)
  adpKey.set(mi.subarray(0, 8), 5)
  return rc4(adpKey, 469)
}

// ---------------------------------------------------------------------------
// DES, for DES-OFB (ALGID 0x81)
// ---------------------------------------------------------------------------

// prettier-ignore
const IP = [58,50,42,34,26,18,10,2,60,52,44,36,28,20,12,4,62,54,46,38,30,22,14,6,64,56,48,40,32,24,16,8,57,49,41,33,25,17,9,1,59,51,43,35,27,19,11,3,61,53,45,37,29,21,13,5,63,55,47,39,31,23,15,7]
// prettier-ignore
const FP = [40,8,48,16,56,24,64,32,39,7,47,15,55,23,63,31,38,6,46,14,54,22,62,30,37,5,45,13,53,21,61,29,36,4,44,12,52,20,60,28,35,3,43,11,51,19,59,27,34,2,42,10,50,18,58,26,33,1,41,9,49,17,57,25]
// prettier-ignore
const E = [32,1,2,3,4,5,4,5,6,7,8,9,8,9,10,11,12,13,12,13,14,15,16,17,16,17,18,19,20,21,20,21,22,23,24,25,24,25,26,27,28,29,28,29,30,31,32,1]
// prettier-ignore
const P = [16,7,20,21,29,12,28,17,1,15,23,26,5,18,31,10,2,8,24,14,32,27,3,9,19,13,30,6,22,11,4,25]
// prettier-ignore
const PC1 = [57,49,41,33,25,17,9,1,58,50,42,34,26,18,10,2,59,51,43,35,27,19,11,3,60,52,44,36,63,55,47,39,31,23,15,7,62,54,46,38,30,22,14,6,61,53,45,37,29,21,13,5,28,20,12,4]
// prettier-ignore
const PC2 = [14,17,11,24,1,5,3,28,15,6,21,10,23,19,12,4,26,8,16,7,27,20,13,2,41,52,31,37,47,55,30,40,51,45,33,48,44,49,39,56,34,53,46,42,50,36,29,32]
// prettier-ignore
const SHIFTS = [1,1,2,2,2,2,2,2,1,2,2,2,2,2,2,1]
// prettier-ignore
const SBOX = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
]

function permute(input: number[], table: number[]): number[] {
  return table.map((t) => input[t - 1])
}
function leftShift(bits: number[], n: number): number[] {
  return bits.slice(n).concat(bits.slice(0, n))
}
function bytesToBits(b: Uint8Array): number[] {
  const out: number[] = []
  for (const byte of b) for (let i = 7; i >= 0; i--) out.push((byte >> i) & 1)
  return out
}
function bitsToBytes(bits: number[]): Uint8Array {
  const out = new Uint8Array(bits.length >> 3)
  for (let i = 0; i < out.length; i++) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i * 8 + j]
    out[i] = v
  }
  return out
}

/** The 16 round keys from an 8 byte DES key. */
export function desRoundKeys(key: Uint8Array): number[][] {
  const kb = permute(bytesToBits(key), PC1)
  let c = kb.slice(0, 28)
  let d = kb.slice(28)
  const keys: number[][] = []
  for (let i = 0; i < 16; i++) {
    c = leftShift(c, SHIFTS[i])
    d = leftShift(d, SHIFTS[i])
    keys.push(permute(c.concat(d), PC2))
  }
  return keys
}

/** One DES block, 8 bytes in, 8 bytes out. */
export function desEncryptBlock(block: Uint8Array, roundKeys: number[][]): Uint8Array {
  let bits = permute(bytesToBits(block), IP)
  let l = bits.slice(0, 32)
  let r = bits.slice(32)
  for (let round = 0; round < 16; round++) {
    const expanded = permute(r, E)
    const x = expanded.map((b, i) => b ^ roundKeys[round][i])
    const out: number[] = []
    for (let s = 0; s < 8; s++) {
      const six = x.slice(s * 6, s * 6 + 6)
      const row = (six[0] << 1) | six[5]
      const col = (six[1] << 3) | (six[2] << 2) | (six[3] << 1) | six[4]
      const val = SBOX[s][row * 16 + col]
      for (let b = 3; b >= 0; b--) out.push((val >> b) & 1)
    }
    const f = permute(out, P)
    const next = l.map((b, i) => b ^ f[i])
    l = r
    r = next
  }
  bits = permute(r.concat(l), FP)
  return bitsToBytes(bits)
}

/** DES-OFB keystream from an 8 byte key and an 8 byte IV (the MI), in bytes. */
export function desOfbKeystream(key: Uint8Array, iv: Uint8Array, blocks: number): Uint8Array {
  const rk = desRoundKeys(key)
  const out = new Uint8Array(blocks * 8)
  let register: Uint8Array = iv.slice(0, 8)
  for (let i = 0; i < blocks; i++) {
    register = desEncryptBlock(register, rk)
    out.set(register, i * 8)
  }
  return out
}

// ---------------------------------------------------------------------------
// AES-256, for AES-OFB (ALGID 0x84)
// ---------------------------------------------------------------------------

// prettier-ignore
const AES_SBOX = new Uint8Array([99,124,119,123,242,107,111,197,48,1,103,43,254,215,171,118,202,130,201,125,250,89,71,240,173,212,162,175,156,164,114,192,183,253,147,38,54,63,247,204,52,165,229,241,113,216,49,21,4,199,35,195,24,150,5,154,7,18,128,226,235,39,178,117,9,131,44,26,27,110,90,160,82,59,214,179,41,227,47,132,83,209,0,237,32,252,177,91,106,203,190,57,74,76,88,207,208,239,170,251,67,77,51,133,69,249,2,127,80,60,159,168,81,163,64,143,146,157,56,245,188,182,218,33,16,255,243,210,205,12,19,236,95,151,68,23,196,167,126,61,100,93,25,115,96,129,79,220,34,42,144,136,70,238,184,20,222,94,11,219,224,50,58,10,73,6,36,92,194,211,172,98,145,149,228,121,231,200,55,109,141,213,78,169,108,86,244,234,101,122,174,8,186,120,37,46,28,166,180,198,232,221,116,31,75,189,139,138,112,62,181,102,72,3,246,14,97,53,87,185,134,193,29,158,225,248,152,17,105,217,142,148,155,30,135,233,206,85,40,223,140,161,137,13,191,230,66,104,65,153,45,15,176,84,187,22])
// prettier-ignore
const RCON = new Uint8Array([0x8d,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36])

function xtime(x: number): number {
  return ((x << 1) ^ ((x & 0x80) !== 0 ? 0x1b : 0)) & 0xff
}
function aesMul(x: number, y: number): number {
  let r = 0
  let a = x
  for (let i = 0; i < 8; i++) {
    if (y & (1 << i)) r ^= a
    a = xtime(a)
  }
  return r & 0xff
}

/** Expands a 32 byte key into the 240 byte AES-256 round key. */
function aes256KeyExpansion(key: Uint8Array): Uint8Array {
  const Nk = 8
  const Nr = 14
  const rk = new Uint8Array(4 * 4 * (Nr + 1))
  rk.set(key.subarray(0, 32))
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    const t = [rk[(i - 1) * 4], rk[(i - 1) * 4 + 1], rk[(i - 1) * 4 + 2], rk[(i - 1) * 4 + 3]]
    if (i % Nk === 0) {
      const tmp = t[0]
      t[0] = AES_SBOX[t[1]] ^ RCON[i / Nk]
      t[1] = AES_SBOX[t[2]]
      t[2] = AES_SBOX[t[3]]
      t[3] = AES_SBOX[tmp]
    } else if (i % Nk === 4) {
      for (let k = 0; k < 4; k++) t[k] = AES_SBOX[t[k]]
    }
    for (let k = 0; k < 4; k++) rk[i * 4 + k] = rk[(i - Nk) * 4 + k] ^ t[k]
  }
  return rk
}

/** One AES-256 block encryption, 16 bytes, column major state as in FIPS-197. */
function aes256EncryptBlock(block: Uint8Array, rk: Uint8Array): Uint8Array {
  const Nr = 14
  const s = block.slice(0, 16)
  const addRoundKey = (round: number): void => {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) s[c * 4 + r] ^= rk[round * 16 + c * 4 + r]
  }
  addRoundKey(0)
  for (let round = 1; round <= Nr; round++) {
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]]
    // ShiftRows on the column major state.
    for (let r = 1; r < 4; r++) {
      const row = [s[r], s[4 + r], s[8 + r], s[12 + r]]
      for (let c = 0; c < 4; c++) s[c * 4 + r] = row[(c + r) % 4]
    }
    if (round !== Nr) {
      for (let c = 0; c < 4; c++) {
        const col = [s[c * 4], s[c * 4 + 1], s[c * 4 + 2], s[c * 4 + 3]]
        s[c * 4] = aesMul(col[0], 2) ^ aesMul(col[1], 3) ^ col[2] ^ col[3]
        s[c * 4 + 1] = col[0] ^ aesMul(col[1], 2) ^ aesMul(col[2], 3) ^ col[3]
        s[c * 4 + 2] = col[0] ^ col[1] ^ aesMul(col[2], 2) ^ aesMul(col[3], 3)
        s[c * 4 + 3] = aesMul(col[0], 3) ^ col[1] ^ col[2] ^ aesMul(col[3], 2)
      }
    }
    addRoundKey(round)
  }
  return s
}

/** AES-256-OFB keystream from a 32 byte key and a 16 byte IV, in bytes. */
export function aesOfbKeystream(key: Uint8Array, iv: Uint8Array, blocks: number): Uint8Array {
  const rk = aes256KeyExpansion(key)
  const out = new Uint8Array(blocks * 16)
  let register: Uint8Array = iv.slice(0, 16)
  for (let i = 0; i < blocks; i++) {
    register = aes256EncryptBlock(register, rk)
    out.set(register, i * 16)
  }
  return out
}

// ---------------------------------------------------------------------------
// message indicator expansion, shared
// ---------------------------------------------------------------------------

/** One step of the P25 LFSR, returning the overflow bit. Mutates the state. */
function stepLfsr(state: { v: bigint }): number {
  const l = state.v
  const ov = Number((l >> 63n) & 1n)
  const fb = Number(((l >> 63n) ^ (l >> 61n) ^ (l >> 45n) ^ (l >> 37n) ^ (l >> 26n) ^ (l >> 14n)) & 1n)
  state.v = ((l << 1n) | BigInt(fb)) & ((1n << 64n) - 1n)
  return ov
}

/** Expands the 64 bit MI into the 128 bit IV AES needs, per TIA-102. */
export function expandMiTo128(mi: Uint8Array): Uint8Array {
  const state = { v: 0n }
  for (let i = 0; i < 8; i++) state.v = (state.v << 8n) + BigInt(mi[i])
  let overflow = 0n
  for (let i = 0; i < 64; i++) overflow = (overflow << 1n) | BigInt(stepLfsr(state))
  const iv = new Uint8Array(16)
  for (let i = 7; i >= 0; i--) {
    iv[i] = Number(overflow & 0xffn)
    overflow >>= 8n
  }
  for (let i = 15; i >= 8; i--) {
    iv[i] = Number(state.v & 0xffn)
    state.v >>= 8n
  }
  return iv
}

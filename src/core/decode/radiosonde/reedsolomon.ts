/**
 * Reed-Solomon RS(255, 231) over GF(256), the code the RS41 protects its
 * frame with.
 *
 * The field polynomial is x^8 + x^4 + x^3 + x^2 + 1 (0x11d), alpha is 2,
 * and the generator's roots are alpha^0 to alpha^23. Byte i of a codeword
 * is the coefficient of x^i, parity in bytes 0 to 23 and data after. Up to
 * twelve wrong bytes per codeword are corrected.
 */

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

export const RS_N = 255
export const RS_PARITY = 24
export const RS_K = RS_N - RS_PARITY

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

function div(a: number, b: number): number {
  if (a === 0) return 0
  return EXP[LOG[a] + 255 - LOG[b]]
}

/** alpha to the power e, any integer e. */
function pow(e: number): number {
  return EXP[((e % 255) + 255) % 255]
}

/** Evaluates a polynomial given lowest coefficient first. */
function evalPoly(p: ArrayLike<number>, x: number): number {
  let y = 0
  for (let i = p.length - 1; i >= 0; i--) y = mul(y, x) ^ p[i]
  return y
}

let generator: Uint8Array | null = null

function gen(): Uint8Array {
  if (generator) return generator
  let g = new Uint8Array([1])
  for (let i = 0; i < RS_PARITY; i++) {
    // multiply by (x - alpha^i), which over GF(2^8) is (x + alpha^i).
    const next = new Uint8Array(g.length + 1)
    const r = pow(i)
    for (let k = 0; k < g.length; k++) {
      next[k] ^= mul(g[k], r)
      next[k + 1] ^= g[k]
    }
    g = next
  }
  generator = g
  return g
}

/** Fills bytes 0 to 23 of a 255 byte codeword with parity for bytes 24 to 254. */
export function rsEncode(cw: Uint8Array): void {
  const g = gen()
  // remainder of data(x) * x^24 / g(x), worked from the top coefficient down.
  const rem = new Uint8Array(RS_PARITY)
  for (let i = RS_N - 1; i >= RS_PARITY; i--) {
    const f = cw[i] ^ rem[RS_PARITY - 1]
    for (let k = RS_PARITY - 1; k > 0; k--) rem[k] = rem[k - 1] ^ mul(f, g[k])
    rem[0] = mul(f, g[0])
  }
  for (let k = 0; k < RS_PARITY; k++) cw[k] = rem[k]
}

/**
 * Corrects a codeword in place. Returns the number of bytes changed, or -1
 * when there are more errors than the code can fix.
 */
export function rsDecode(cw: Uint8Array): number {
  const S = new Uint8Array(RS_PARITY)
  let any = false
  for (let j = 0; j < RS_PARITY; j++) {
    S[j] = evalPoly(cw, pow(j))
    if (S[j]) any = true
  }
  if (!any) return 0

  // berlekamp-massey for the error locator
  let lambda = new Uint8Array(RS_PARITY + 1)
  lambda[0] = 1
  let prev = new Uint8Array(RS_PARITY + 1)
  prev[0] = 1
  let L = 0
  let m = 1
  let b = 1
  for (let n = 0; n < RS_PARITY; n++) {
    let d = S[n]
    for (let i = 1; i <= L; i++) d ^= mul(lambda[i], S[n - i])
    if (d === 0) {
      m++
      continue
    }
    const coef = div(d, b)
    const t = lambda.slice()
    for (let i = 0; i + m <= RS_PARITY; i++) lambda[i + m] ^= mul(coef, prev[i])
    if (2 * L <= n) {
      L = n + 1 - L
      prev = t
      b = d
      m = 1
    } else {
      m++
    }
  }
  if (L > RS_PARITY / 2) return -1

  // chien search: an error at position p makes lambda(alpha^-p) zero.
  const where: number[] = []
  for (let p = 0; p < RS_N; p++) {
    if (evalPoly(lambda.subarray(0, L + 1), pow(-p)) === 0) where.push(p)
  }
  if (where.length !== L) return -1

  // omega = S(x) lambda(x) mod x^24, then forney with the first root at alpha^0.
  const omega = new Uint8Array(RS_PARITY)
  for (let i = 0; i < RS_PARITY; i++) {
    let v = 0
    for (let k = 0; k <= Math.min(i, L); k++) v ^= mul(lambda[k], S[i - k])
    omega[i] = v
  }
  // the formal derivative keeps the odd terms only.
  const deriv = new Uint8Array(L)
  for (let i = 1; i <= L; i += 2) deriv[i - 1] = lambda[i]
  for (const p of where) {
    const xinv = pow(-p)
    const num = evalPoly(omega, xinv)
    const den = evalPoly(deriv, xinv)
    if (den === 0) return -1
    cw[p] ^= mul(pow(p), div(num, den))
  }
  for (let j = 0; j < RS_PARITY; j++) if (evalPoly(cw, pow(j))) return -1
  return L
}

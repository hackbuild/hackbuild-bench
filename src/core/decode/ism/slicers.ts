/**
 * Pulse slicers: pulse and gap widths in, rows of bits out.
 *
 * A port of the PCM (NRZ and RZ), PPM, PWM and Manchester slicers from
 * rtl_433's pulse_slicer.c (GPL-2.0-or-later, Tommy Vestermark). Each slicer
 * hands every completed message to the protocol's decode and counts what it
 * emitted.
 */

import { BitBuffer } from './bitbuffer'
import type { IsmMessage, IsmProtocol, PulseData } from './types'

type Emit = (m: IsmMessage, bits: BitBuffer) => void

interface Widths {
  short: number
  long: number
  reset: number
  gap: number
  sync: number
  tol: number
}

function widths(p: PulseData, proto: IsmProtocol): Widths | null {
  const spu = Math.fround(p.sampleRate / 1e6)
  const w = (us: number | undefined): number => Math.trunc(Math.fround((us ?? 0) * spu))
  const out: Widths = {
    short: w(proto.shortUs),
    long: w(proto.longUs),
    reset: w(proto.resetUs),
    gap: w(proto.gapUs),
    sync: w(proto.syncUs),
    tol: w(proto.toleranceUs),
  }
  // a protocol too fast for the rate rounds to zero samples and cannot be sliced.
  if (
    (proto.shortUs > 0 && out.short <= 0) ||
    (proto.longUs > 0 && out.long <= 0) ||
    (proto.resetUs > 0 && out.reset <= 0) ||
    ((proto.gapUs ?? 0) > 0 && out.gap <= 0) ||
    ((proto.syncUs ?? 0) > 0 && out.sync <= 0) ||
    ((proto.toleranceUs ?? 0) > 0 && out.tol <= 0)
  ) {
    return null
  }
  return out
}

function account(proto: IsmProtocol, bits: BitBuffer, emit: Emit): number {
  const ret = proto.decode(bits, (m) => emit(m, bits))
  return ret > 0 ? ret : 0
}

export function slicePcm(p: PulseData, proto: IsmProtocol, bits: BitBuffer, emit: Emit): number {
  const w = widths(p, proto)
  if (!w) return 0
  const spu = Math.fround(p.sampleRate / 1e6)
  let fShort = proto.shortUs > 0 ? Math.fround(1 / Math.fround(proto.shortUs * spu)) : 0
  let fLong = proto.longUs > 0 ? Math.fround(1 / Math.fround(proto.longUs * spu)) : 0
  const { short: sShort, long: sLong, reset: sReset } = w
  let tol = w.tol
  let events = 0
  bits.clear()

  const gapLimit = w.gap ? w.gap : sReset
  const maxZeros = Math.trunc(gapLimit / sLong)
  if (tol <= 0) tol = Math.trunc(sLong / 4)

  let minCount = sShort === sLong ? 12 : 4
  let preambleLen = 0
  const P = p.pulse
  const G = p.gap
  const N = p.num

  for (let n = 0; sShort !== sLong && n < N; ++n) {
    let sw = 0
    let lw = 0
    let count = 0
    while (
      n < N &&
      P[n] >= sShort - tol &&
      P[n] <= sShort + tol &&
      P[n] + G[n] >= sLong - tol &&
      P[n] + G[n] <= sLong + tol
    ) {
      sw += P[n]
      lw += P[n] + G[n]
      count++
      n++
    }
    if (count >= minCount) {
      fLong = Math.fround(count / lw)
      fShort = Math.fround(count / sw)
      minCount = count
      preambleLen = count
    }
  }
  let rzs = 0
  let rzl = 0
  let rzc = 0
  for (let n = 0; preambleLen === 0 && sShort !== sLong && n < N; ++n) {
    if (P[n] >= sShort - tol && P[n] <= sShort + tol && P[n] + G[n] >= sLong - tol && P[n] + G[n] <= sLong + tol) {
      rzs += P[n]
      rzl += P[n] + G[n]
      rzc++
    }
  }
  if (rzc > 8) {
    fLong = Math.fround(rzc / rzl)
    fShort = Math.fround(rzc / rzs)
  }
  for (let n = 0; sShort === sLong && n < N; ++n) {
    let width = 0
    let count = 0
    while (
      n < N &&
      Math.trunc(Math.fround(P[n] * fShort) + 0.5) === 1 &&
      Math.trunc(Math.fround(G[n] * fLong) + 0.5) === 1
    ) {
      width += P[n] + G[n]
      count += 2
      n++
    }
    if (count >= minCount) {
      fShort = fLong = Math.fround(count / width)
      minCount = count
      preambleLen = count
    }
  }
  let nrzw = 0
  let nrzc = 0
  for (let n = 0; preambleLen === 0 && sShort === sLong && n < N; ++n) {
    if (P[n] >= sShort - tol && P[n] <= sShort + tol) {
      nrzw += P[n]
      nrzc += 1
    }
    if (P[n] >= 2 * sShort - tol && P[n] <= 2 * sShort + tol) {
      nrzw += P[n]
      nrzc += 2
    }
    if (G[n] >= sLong - tol && G[n] <= sLong + tol) {
      nrzw += G[n]
      nrzc += 1
    }
    if (G[n] >= 2 * sLong - tol && G[n] <= 2 * sLong + tol) {
      nrzw += G[n]
      nrzc += 2
    }
  }
  if (nrzc > 20) fShort = fLong = Math.fround(nrzc / nrzw)

  for (let n = 0; n < N; ++n) {
    const highs = Math.trunc(Math.fround(Math.fround(P[n] * fShort) + 0.5))
    let lows = Math.trunc(Math.fround(Math.fround((G[n] + sShort - sLong) * fLong) + 0.5))
    for (let i = 0; i < highs; ++i) bits.addBit(1)
    lows = Math.min(lows, maxZeros)
    for (let i = 0; i < lows; ++i) bits.addBit(0)

    if (sShort !== sLong && Math.abs(P[n] - sShort) > tol) {
      bits.clear()
    } else if (G[n] > gapLimit && G[n] <= sReset) {
      bits.addRow()
    }
    if ((n === N - 1 || G[n] > sReset) && (bits.bits[0] > 0 || bits.numRows > 1)) {
      events += account(proto, bits, emit)
      bits.clear()
    }
  }
  return events
}

export function slicePpm(p: PulseData, proto: IsmProtocol, bits: BitBuffer, emit: Emit): number {
  const w = widths(p, proto)
  if (!w) return 0
  let events = 0
  bits.clear()
  let zeroL: number
  let zeroU: number
  let oneL: number
  let oneU: number
  let syncL = 0
  let syncU = 0
  if (w.tol > 0) {
    zeroL = w.short - w.tol
    zeroU = w.short + w.tol
    oneL = w.long - w.tol
    oneU = w.long + w.tol
    if (w.sync > 0) {
      syncL = w.sync - w.tol
      syncU = w.sync + w.tol
    }
  } else {
    zeroL = 0
    zeroU = Math.trunc((w.short + w.long) / 2) + 1
    oneL = zeroU - 1
    oneU = w.gap ? w.gap : w.reset
  }
  const G = p.gap
  for (let n = 0; n < p.num; ++n) {
    const g = G[n]
    if (g > zeroL && g < zeroU) bits.addBit(0)
    else if (g > oneL && g < oneU) bits.addBit(1)
    else if (g > syncL && g < syncU) bits.addSync()
    else if (g < w.reset) bits.addRow()
    if ((n === p.num - 1 || g >= w.reset) && (bits.bits[0] > 0 || bits.numRows > 1)) {
      events += account(proto, bits, emit)
      bits.clear()
    }
  }
  return events
}

export function slicePwm(p: PulseData, proto: IsmProtocol, bits: BitBuffer, emit: Emit): number {
  const w = widths(p, proto)
  if (!w) return 0
  let events = 0
  bits.clear()
  const { short: s, long: l, sync: y, tol } = w
  let oneL: number
  let oneU: number
  let zeroL: number
  let zeroU: number
  let syncL = 0
  let syncU = 0
  const mid = (a: number, b: number): number => Math.trunc((a + b) / 2) + 1
  if (tol > 0) {
    oneL = s - tol
    oneU = s + tol
    zeroL = l - tol
    zeroU = l + tol
    if (y > 0) {
      syncL = y - tol
      syncU = y + tol
    }
  } else if (y <= 0) {
    oneL = 0
    oneU = mid(s, l)
    zeroL = oneU - 1
    zeroU = Number.MAX_SAFE_INTEGER
  } else if (y < s) {
    syncL = 0
    syncU = mid(y, s)
    oneL = syncU - 1
    oneU = mid(s, l)
    zeroL = oneU - 1
    zeroU = Number.MAX_SAFE_INTEGER
  } else if (y < l) {
    oneL = 0
    oneU = mid(s, y)
    syncL = oneU - 1
    syncU = mid(y, l)
    zeroL = syncU - 1
    zeroU = Number.MAX_SAFE_INTEGER
  } else {
    oneL = 0
    oneU = mid(s, l)
    zeroL = oneU - 1
    zeroU = mid(l, y)
    syncL = zeroU - 1
    syncU = Number.MAX_SAFE_INTEGER
  }
  const P = p.pulse
  const G = p.gap
  for (let n = 0; n < p.num; ++n) {
    const v = P[n]
    if (v > oneL && v < oneU) bits.addBit(1)
    else if (v > zeroL && v < zeroU) bits.addBit(0)
    else if (v > syncL && v < syncU) bits.addSync()
    else if (v <= oneL) {
      // spurious short pulse, ignored
    } else bits.addRow()

    if ((n === p.num - 1 || G[n] > w.reset) && bits.numRows > 0) {
      events += account(proto, bits, emit)
      bits.clear()
    } else if (w.gap > 0 && G[n] > w.gap && bits.numRows > 0 && bits.bits[bits.numRows - 1] > 0) {
      bits.addRow()
    }
  }
  return events
}

export function sliceManchester(p: PulseData, proto: IsmProtocol, bits: BitBuffer, emit: Emit): number {
  const w = widths(p, proto)
  if (!w) return 0
  let events = 0
  let since = 0
  const s = w.short
  const tol = w.tol
  bits.clear()
  bits.addBit(0)
  const P = p.pulse
  const G = p.gap
  for (let n = 0; n < p.num; ++n) {
    if (tol > 0 && (P[n] < s - tol || P[n] > s * 2 + tol || G[n] < s - tol || G[n] > s * 2 + tol)) {
      if (P[n] > s * 1.5 && P[n] <= s * 2 + tol) bits.addBit(1)
      bits.addRow()
      bits.addBit(0)
      since = 0
    } else if (P[n] + since > s * 1.5) {
      bits.addBit(1)
      since = 0
    } else {
      since += P[n]
    }

    if ((n === p.num - 1 || G[n] > w.reset) && bits.numRows > 0) {
      events += account(proto, bits, emit)
      bits.clear()
      bits.addBit(0)
      since = 0
    } else if (G[n] + since > s * 1.5) {
      bits.addBit(0)
      since = 0
    } else {
      since += G[n]
    }
  }
  return events
}

export const SLICERS: Record<'pcm' | 'ppm' | 'pwm' | 'manchester', typeof slicePcm> = {
  pcm: slicePcm,
  ppm: slicePpm,
  pwm: slicePwm,
  manchester: sliceManchester,
}

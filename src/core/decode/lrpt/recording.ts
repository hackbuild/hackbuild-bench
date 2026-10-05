/**
 * Baseband recordings as people share them: a two channel wav from SDR#,
 * SatDump or GQRX, or a headerless dump of unsigned 8 bit (cu8, what
 * rtl_sdr writes), signed 16 bit (cs16) or 32 bit float (cf32) pairs. A
 * headerless file gives its sample rate and centre only in its name, if at
 * all, so the caller reads the name or asks for them.
 */

export type BasebandFormat = 'cu8' | 'cs16' | 'cf32'

export interface BasebandLayout {
  format: BasebandFormat
  /** 0 when the file does not say. */
  sampleRate: number
  dataOffset: number
  /** Bytes per complex sample. */
  frame: number
}

const FRAME: Record<BasebandFormat, number> = { cu8: 2, cs16: 4, cf32: 8 }

/** Reads the layout from the first bytes of a file and its name. */
export function basebandLayout(head: Uint8Array, name: string): BasebandLayout | string {
  const ascii = (o: number, n: number) => String.fromCharCode(...head.subarray(o, o + n))
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
    let p = 12
    let rate = 0
    let channels = 0
    let bits = 0
    let tag = 0
    while (p + 8 <= head.length) {
      const id = ascii(p, 4)
      const len = view.getUint32(p + 4, true)
      if (id === 'fmt ') {
        tag = view.getUint16(p + 8, true)
        channels = view.getUint16(p + 10, true)
        rate = view.getUint32(p + 12, true)
        bits = view.getUint16(p + 22, true)
      }
      if (id === 'data') {
        if (channels !== 2) return 'that wav has one channel, so it is audio. a baseband recording has two, i and q.'
        const format: BasebandFormat | null =
          bits === 8 ? 'cu8' : bits === 16 ? 'cs16' : bits === 32 && tag === 3 ? 'cf32' : null
        if (!format) return `a ${bits} bit wav is not a baseband layout this reads.`
        return { format, sampleRate: rate, dataOffset: p + 8, frame: FRAME[format] }
      }
      p += 8 + len + (len & 1)
    }
    return 'that wav has no data chunk in its first 64 kB.'
  }
  const lower = name.toLowerCase()
  const format: BasebandFormat = lower.endsWith('.cs16') || lower.endsWith('.s16')
    ? 'cs16'
    : lower.endsWith('.cf32') || lower.endsWith('.fc32') || lower.endsWith('.raw')
      ? 'cf32'
      : 'cu8'
  return { format, sampleRate: 0, dataOffset: 0, frame: FRAME[format] }
}

/** Converts whole complex samples to interleaved floats in about -1 to 1. */
export function basebandToFloat(bytes: Uint8Array, format: BasebandFormat): Float32Array {
  if (format === 'cu8') {
    const out = new Float32Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] - 127.5) / 128
    return out
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (format === 'cs16') {
    const out = new Float32Array(bytes.length >> 1)
    for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768
    return out
  }
  const out = new Float32Array(bytes.length >> 2)
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
  return out
}

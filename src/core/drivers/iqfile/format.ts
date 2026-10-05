/**
 * Reading IQ recordings: which sample format a file holds, where its samples
 * start, and what centre and rate it was taken at.
 *
 * The centre and rate come from the wav header when there is one, and
 * otherwise from the naming conventions the common tools write: rtl_433,
 * SDR#, SDR++, gqrx and this bench's own recorder.
 */

export type SampleFormat = 'cu8' | 'cs8' | 'cs16' | 'cf32'

/** Bytes per complex sample, I and Q together. */
export const SAMPLE_BYTES: Record<SampleFormat, number> = { cu8: 2, cs8: 2, cs16: 4, cf32: 8 }

export interface IqLayout {
  format: SampleFormat
  /** Where the samples start, after any header. */
  dataOffset: number
  /** How many bytes of samples follow. */
  dataBytes: number
  sampleRate?: number
  centerHz?: number
}

const BY_EXTENSION: Record<string, SampleFormat> = {
  cu8: 'cu8',
  u8: 'cu8',
  bin: 'cu8',
  cs8: 'cs8',
  s8: 'cs8',
  cs16: 'cs16',
  s16: 'cs16',
  cf32: 'cf32',
  f32: 'cf32',
  cfile: 'cf32',
  raw: 'cf32',
}

/** Extensions offered in the file picker. */
export const IQ_EXTENSIONS = ['.cu8', '.u8', '.bin', '.cs8', '.s8', '.cs16', '.s16', '.cf32', '.f32', '.cfile', '.raw', '.wav']

function scaled(v: string, unit: string | undefined): number {
  const n = Number(v)
  const u = (unit ?? '').toLowerCase()
  return u === 'g' ? n * 1e9 : u === 'm' ? n * 1e6 : u === 'k' ? n * 1e3 : n
}

/** What a file name says about the recording. Anything it does not say is left out. */
export function fromName(name: string): { centerHz?: number; sampleRate?: number; format?: SampleFormat } {
  const out: { centerHz?: number; sampleRate?: number; format?: SampleFormat } = {}
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (BY_EXTENSION[ext]) out.format = BY_EXTENSION[ext]

  // gqrx: gqrx_20240101_120000_100300000_2400000_fc.raw
  const gqrx = /gqrx_\d{8}_\d{6}_(\d+)_(\d+)_fc/i.exec(name)
  if (gqrx) return { ...out, centerHz: Number(gqrx[1]), sampleRate: Number(gqrx[2]), format: 'cf32' }

  // rtl_433: g001_433.92M_250k.cu8
  const r433 = /_(\d+(?:\.\d+)?)M_(\d+(?:\.\d+)?)k\b/i.exec(name)
  if (r433) return { ...out, centerHz: Number(r433[1]) * 1e6, sampleRate: Number(r433[2]) * 1e3 }

  // SDR#, SDR++ and this bench: 100300000Hz, or 1090MHz, and 2400000sps or 2.4Msps
  const hz = /(\d+(?:\.\d+)?)\s*([kmg])?hz/i.exec(name)
  if (hz) out.centerHz = scaled(hz[1], hz[2])
  const sps = /(\d+(?:\.\d+)?)\s*([kmg])?sps/i.exec(name)
  if (sps) out.sampleRate = scaled(sps[1], sps[2])
  return out
}

/**
 * Reads the start of a file to find its layout. A wav is parsed for its
 * format, its data chunk, and the auxi chunk SDR# writes the centre into.
 */
export function layoutOf(name: string, head: DataView, totalBytes: number): IqLayout {
  const named = fromName(name)
  const riff = head.byteLength >= 12 ? tag(head, 0) : ''
  if ((riff === 'RIFF' || riff === 'RF64' || riff === 'BW64') && tag(head, 8) === 'WAVE') {
    return wavLayout(head, totalBytes, named)
  }
  const format = named.format ?? 'cu8'
  return {
    format,
    dataOffset: 0,
    dataBytes: totalBytes - (totalBytes % SAMPLE_BYTES[format]),
    sampleRate: named.sampleRate,
    centerHz: named.centerHz,
  }
}

function tag(v: DataView, at: number): string {
  return String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3))
}

function wavLayout(
  v: DataView,
  totalBytes: number,
  named: { centerHz?: number; sampleRate?: number },
): IqLayout {
  let at = 12
  let format: SampleFormat | null = null
  let sampleRate = named.sampleRate
  let centerHz = named.centerHz
  /** RF64 and BW64 keep the real data size in a ds64 chunk and write 0xffffffff in the data chunk. */
  let ds64Data: number | null = null
  while (at + 8 <= v.byteLength) {
    const id = tag(v, at)
    const size = v.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'ds64' && body + 16 <= v.byteLength) {
      ds64Data = v.getUint32(body + 8, true) + v.getUint32(body + 12, true) * 2 ** 32
    } else if (id === 'fmt ') {
      let audioFormat = v.getUint16(body, true)
      // the extensible format names the real one in the first two bytes of its subformat guid.
      if (audioFormat === 0xfffe && size >= 40) audioFormat = v.getUint16(body + 24, true)
      const channels = v.getUint16(body + 2, true)
      sampleRate = v.getUint32(body + 4, true)
      const bits = v.getUint16(body + 14, true)
      if (channels !== 2) throw new Error(`this wav has ${channels} channels. an iq recording has two.`)
      if (audioFormat === 3 && bits === 32) format = 'cf32'
      else if (bits === 16) format = 'cs16'
      else if (bits === 8) format = 'cu8'
      else throw new Error(`this wav holds ${bits} bit samples, which the player does not read.`)
    } else if (id === 'auxi' && size >= 36 && body + 36 <= v.byteLength) {
      // SDR# writes two SYSTEMTIMEs, then the centre frequency.
      const c = v.getUint32(body + 32, true)
      if (c > 0) centerHz = c
    } else if (id === 'data') {
      if (!format) throw new Error('this wav has its samples before its format, which is not a valid wav.')
      const rest = totalBytes - body
      let declared = size
      if (ds64Data !== null && size === 0xffffffff) declared = ds64Data
      // a plain wav past 4 gb wraps its size field, which leaves the rest of
      // the file a whole number of 4 gb steps beyond what it declares.
      else if (rest > size && (rest - size) % 2 ** 32 === 0) declared = rest
      const bytes = Math.min(declared, rest)
      return { format, dataOffset: body, dataBytes: bytes - (bytes % SAMPLE_BYTES[format]), sampleRate, centerHz }
    }
    at = body + size + (size & 1)
  }
  throw new Error('no data chunk in the first part of this wav.')
}

/** Converts raw samples to interleaved floats in about -1..1, the way the radios emit them. */
export function toFloats(bytes: Uint8Array, format: SampleFormat): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (format) {
    case 'cu8': {
      const out = new Float32Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] - 127.5) / 127.5
      return out
    }
    case 'cs8': {
      const out = new Float32Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) out[i] = view.getInt8(i) / 128
      return out
    }
    case 'cs16': {
      const out = new Float32Array(bytes.length >> 1)
      for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768
      return out
    }
    case 'cf32': {
      const out = new Float32Array(bytes.length >> 2)
      for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
      return out
    }
  }
}

/** Interleaved floats back to unsigned 8 bit, the rtl_sdr .cu8 format. */
export function toCu8(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.round(samples[i] * 127.5 + 127.5)
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  return out
}

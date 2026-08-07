/**
 * Minimal protobuf wire reader. Enough to pull named fields out of the
 * Meshtastic messages without the generated runtime.
 *
 * Only the four wire types the messages use are handled: varint, 64 bit, length
 * delimited, and 32 bit. A field that repeats keeps its last occurrence, which
 * is all the messages here need.
 */

export const WIRE_VARINT = 0
export const WIRE_I64 = 1
export const WIRE_LEN = 2
export const WIRE_I32 = 5

export interface DecodedField {
  field: number
  wireType: number
  /** Present for wire type 0. */
  varint?: bigint
  /** Present for wire type 2. */
  bytes?: Uint8Array
  /** Present for wire type 1, unsigned. */
  fixed64?: bigint
  /** Present for wire type 5, unsigned. */
  fixed32?: number
}

export function readVarint(bytes: Uint8Array, pos: number): { value: bigint; next: number } {
  let result = 0n
  let shift = 0n
  let i = pos
  while (i < bytes.length) {
    const b = bytes[i]
    result |= BigInt(b & 0x7f) << shift
    i++
    if ((b & 0x80) === 0) return { value: result, next: i }
    shift += 7n
  }
  throw new Error('truncated varint')
}

export function readLengthDelimited(
  bytes: Uint8Array,
  pos: number,
): { value: Uint8Array; next: number } {
  const { value: len, next } = readVarint(bytes, pos)
  const end = next + Number(len)
  if (end > bytes.length) throw new Error('truncated length-delimited field')
  return { value: bytes.slice(next, end), next: end }
}

export function decodeMessage(bytes: Uint8Array): Map<number, DecodedField> {
  const out = new Map<number, DecodedField>()
  let pos = 0
  while (pos < bytes.length) {
    const tag = readVarint(bytes, pos)
    pos = tag.next
    const field = Number(tag.value >> 3n)
    const wireType = Number(tag.value & 7n)
    const entry: DecodedField = { field, wireType }
    switch (wireType) {
      case WIRE_VARINT: {
        const r = readVarint(bytes, pos)
        entry.varint = r.value
        pos = r.next
        break
      }
      case WIRE_I64: {
        if (pos + 8 > bytes.length) throw new Error('truncated 64-bit field')
        const dv = new DataView(bytes.buffer, bytes.byteOffset + pos, 8)
        entry.fixed64 = dv.getBigUint64(0, true)
        pos += 8
        break
      }
      case WIRE_LEN: {
        const r = readLengthDelimited(bytes, pos)
        entry.bytes = r.value
        pos = r.next
        break
      }
      case WIRE_I32: {
        if (pos + 4 > bytes.length) throw new Error('truncated 32-bit field')
        const dv = new DataView(bytes.buffer, bytes.byteOffset + pos, 4)
        entry.fixed32 = dv.getUint32(0, true)
        pos += 4
        break
      }
      default:
        throw new Error(`unsupported wire type ${wireType}`)
    }
    out.set(field, entry)
  }
  return out
}

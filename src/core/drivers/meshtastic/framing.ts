/**
 * Meshtastic serial framing. Every packet on the wire is:
 *
 *   0x94 0xc3  <len hi> <len lo>  <len protobuf bytes>
 *
 * The two magic bytes mark the start, the big endian uint16 is the protobuf
 * length, then that many bytes of a FromRadio or ToRadio message. Debug text
 * the firmware prints is interleaved with frames, so the reader resyncs on the
 * magic and drops anything between frames.
 */

export const FRAME_MAGIC0 = 0x94
export const FRAME_MAGIC1 = 0xc3

/** Largest protobuf the firmware will send or accept in one frame. */
export const MAX_FRAME_PAYLOAD = 512

export function encodeFrame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(payload.length + 4)
  out[0] = FRAME_MAGIC0
  out[1] = FRAME_MAGIC1
  out[2] = (payload.length >> 8) & 0xff
  out[3] = payload.length & 0xff
  out.set(payload, 4)
  return out
}

/**
 * Accumulates serial chunks and yields complete payloads. Bytes that are not
 * part of a valid frame, including firmware log text, are skipped by advancing
 * to the next magic. A length that runs past MAX_FRAME_PAYLOAD is treated as a
 * false magic and the scan moves on by one byte.
 */
export class StreamFramer {
  private buf = new Uint8Array(0)

  push(chunk: Uint8Array): Uint8Array[] {
    const merged = new Uint8Array(this.buf.length + chunk.length)
    merged.set(this.buf)
    merged.set(chunk, this.buf.length)
    this.buf = merged

    const out: Uint8Array[] = []
    let i = 0
    while (i < this.buf.length) {
      if (this.buf[i] !== FRAME_MAGIC0) {
        i++
        continue
      }
      if (i + 1 >= this.buf.length) break // partial magic, wait for more
      if (this.buf[i + 1] !== FRAME_MAGIC1) {
        i++
        continue
      }
      if (i + 4 > this.buf.length) break // header incomplete
      const len = (this.buf[i + 2] << 8) | this.buf[i + 3]
      if (len > MAX_FRAME_PAYLOAD) {
        i++ // not a real frame, resync past this magic byte
        continue
      }
      if (i + 4 + len > this.buf.length) break // payload incomplete
      out.push(this.buf.slice(i + 4, i + 4 + len))
      i += 4 + len
    }

    this.buf = this.buf.slice(i)
    return out
  }
}

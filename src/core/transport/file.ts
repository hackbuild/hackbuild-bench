/**
 * Local files as a transport. Drivers use this, never the pickers directly.
 *
 * Opening uses the file system access picker where the browser has one and a
 * file input otherwise. Saving streams to disk where the picker exists, so an
 * hour of samples never sits in memory, and falls back to a download.
 */

interface OpenPickerWindow {
  showOpenFilePicker?: (opts: {
    multiple?: boolean
    types?: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<Array<{ getFile(): Promise<File> }>>
  showSaveFilePicker?: (opts: {
    suggestedName?: string
    types?: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<{ createWritable(): Promise<WritableFile> }>
}

interface WritableFile {
  write(data: BufferSource | Blob): Promise<void>
  close(): Promise<void>
  abort?(): Promise<void>
}

/** Asks for one file. Null when the picker is dismissed. Must run from a user gesture. */
export async function pickFile(extensions: string[], description: string): Promise<File | null> {
  const w = window as unknown as OpenPickerWindow
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({
        types: [{ description, accept: { 'application/octet-stream': extensions } }],
      })
      return handle ? await handle.getFile() : null
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      throw err
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = extensions.join(',')
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

/** Somewhere bytes can be appended to as they arrive. */
export interface FileSink {
  write(bytes: Uint8Array): Promise<void>
  close(): Promise<void>
  /** Bytes written so far. */
  readonly size: number
  /** Bytes handed to write that the disk has not taken yet. */
  readonly queued: number
  /** False when the browser has no save picker and the bytes are held for a download at close. */
  readonly streaming: boolean
}

/**
 * Asks where to save and returns a sink. Null when the picker is dismissed.
 * Without a save picker the bytes are held, up to holdLimit, and downloaded
 * at close.
 */
export async function saveFile(
  suggestedName: string,
  description: string,
  holdLimit: number,
): Promise<FileSink | null> {
  const w = window as unknown as OpenPickerWindow
  if (w.showSaveFilePicker) {
    let writable: WritableFile
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: [{ description, accept: { 'application/octet-stream': [extOf(suggestedName)] } }],
      })
      writable = await handle.createWritable()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      throw err
    }
    let size = 0
    let queued = 0
    // writes are chained so they land in order however fast they arrive. A
    // failed write must not poison the chain, or close never runs and the
    // browser throws away everything already written.
    let chain: Promise<void> = Promise.resolve()
    return {
      streaming: true,
      get size() {
        return size
      },
      get queued() {
        return queued
      },
      write(bytes) {
        size += bytes.length
        queued += bytes.length
        const done = chain.then(() => writable.write(bytes as Uint8Array<ArrayBuffer>))
        chain = done.then(
          () => {
            queued -= bytes.length
          },
          () => {
            queued -= bytes.length
          },
        )
        return done
      },
      async close() {
        await chain
        await writable.close()
      },
    }
  }
  const parts: Uint8Array[] = []
  let size = 0
  return {
    streaming: false,
    get size() {
      return size
    },
    queued: 0,
    async write(bytes) {
      if (size + bytes.length > holdLimit) throw new Error('recording is over the size this browser can hold')
      parts.push(bytes)
      size += bytes.length
    },
    async close() {
      const url = URL.createObjectURL(new Blob(parts as BlobPart[]))
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    },
  }
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot) : '.bin'
}

import { onBeforeUnmount, ref } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import { saveFile } from '@/core/transport/file'
import type { FileSink } from '@/core/transport/file'
import { toCu8 } from '@/core/drivers/iqfile/format'
import type { Artifact, IqChunk } from '@/core/types'

/** What a browser with no save picker may hold before the recording stops itself. */
const HOLD_LIMIT = 512 * 1024 * 1024

/** Past this much waiting on the disk the recording stops, rather than fill memory. */
const QUEUE_LIMIT = 64 * 1024 * 1024

/**
 * Writes a device's iq to a .cu8 file, named the way the recording player
 * reads the centre and the rate back. A file holds one centre and one rate,
 * so a retune or a rate change ends the recording instead of corrupting it.
 */
export function useIqRecorder(deviceId: string) {
  const recording = ref(false)
  const bytes = ref(0)
  const seconds = ref(0)
  const error = ref<string | null>(null)
  /** False when the browser holds the bytes for a download at the end. */
  const streaming = ref(true)

  let sink: FileSink | null = null
  let unsub: (() => void) | null = null
  let centerHz = 0
  let rate = 0
  let samples = 0

  async function start(): Promise<void> {
    if (recording.value) return
    error.value = null
    const node = bus.node(deviceId)
    if (!node) return
    centerHz = Math.round(node.params.centerHz ?? 0)
    rate = Math.round(node.params.sampleRate ?? 0)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    sink = await saveFile(`iq_${centerHz}Hz_${rate}sps_${stamp}.cu8`, 'iq recordings', HOLD_LIMIT)
    if (!sink) return
    streaming.value = sink.streaming
    samples = 0
    bytes.value = 0
    seconds.value = 0
    recording.value = true
    unsub = bus.onDeviceArtifact(deviceId, (a: Artifact) => {
      if (a.kind !== 'iq' || !sink) return
      const c = a as IqChunk
      if (Math.abs(c.centerHz - centerHz) > 1000 || Math.abs(c.sampleRate - rate) > 1) {
        void finish('the radio retuned, so the recording ended there')
        return
      }
      if (sink.queued > QUEUE_LIMIT) {
        void finish('the disk is not keeping up with the radio')
        return
      }
      const out = toCu8(c.samples)
      sink.write(out).catch((err: unknown) => void finish(err instanceof Error ? err.message : String(err)))
      samples += c.samples.length / 2
      bytes.value = sink.size
      seconds.value = samples / rate
    })
  }

  async function finish(reason?: string): Promise<void> {
    if (!recording.value) return
    recording.value = false
    unsub?.()
    unsub = null
    const s = sink
    sink = null
    if (reason) error.value = reason
    try {
      await s?.close()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  onBeforeUnmount(() => void finish())

  return { recording, bytes, seconds, error, streaming, start, stop: () => finish() }
}

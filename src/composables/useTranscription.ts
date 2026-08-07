import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import { Transcriber } from '@/core/audio/transcriber'
import { hasWebGPU } from '@/core/transport/support'
import type { Artifact, AudioChunk } from '@/core/types'

export interface TranscriptLine {
  text: string
  at: number
  fromHz?: number
  toHz?: number
  seconds?: number
}

/**
 * Whisper transcription over a device's demodulated audio.
 *
 * The model is fetched the first time it is enabled and then runs locally.
 * Nothing about this path sends audio anywhere.
 */
export function useTranscription(deviceId: string) {
  const ready = ref(false)
  const loading = ref(false)
  const progress = ref(0)
  const error = ref<string | null>(null)
  const lines = ref<TranscriptLine[]>([])
  const model = ref('whisper tiny.en')
  const backend = ref(hasWebGPU() ? 'webgpu' : 'wasm')
  /** Live one line status from the engine, so you can see audio is flowing. */
  const status = ref('off')
  /** Total seconds of audio handed to the model, proof it is being fed. */
  const fedSeconds = ref(0)

  const engine = shallowRef<Transcriber | null>(null)
  let statusTimer: ReturnType<typeof setInterval> | null = null

  /** Set by the spirit box so a caught word carries the frequency it came from. */
  const tagRange = ref<{ fromHz: number; toHz: number } | null>(null)

  const stopStream = bus.onDeviceArtifact(deviceId, (a: Artifact) => {
    if (a.kind !== 'audio' || !ready.value) return
    const chunk = a as AudioChunk
    engine.value?.feed(chunk.samples, chunk.sampleRate)
    if (chunk.sampleRate > 0) fedSeconds.value += chunk.samples.length / chunk.sampleRate
  })

  async function enable(): Promise<void> {
    if (loading.value || ready.value) return
    loading.value = true
    error.value = null
    try {
      const t = new Transcriber()
      if (!t.available()) {
        error.value = 'this browser cannot run the transcriber'
        return
      }
      await t.load((p) => {
        progress.value = Math.round(p.progress)
      })
      t.on('text', (r) => {
        const line: TranscriptLine = { text: r.text, at: r.at }
        if (tagRange.value) {
          line.fromHz = tagRange.value.fromHz
          line.toHz = tagRange.value.toHz
        }
        lines.value = [...lines.value, line].slice(-200)
      })
      engine.value = t
      backend.value = t.backend
      ready.value = true
      statusTimer = setInterval(() => {
        if (engine.value) status.value = engine.value.status()
      }, 500)
    } catch (err) {
      error.value =
        err instanceof Error
          ? err.message
          : 'the transcriber could not start. it needs one network fetch to download the model.'
    } finally {
      loading.value = false
    }
  }

  function disable(): void {
    engine.value?.stop()
    engine.value = null
    ready.value = false
    status.value = 'off'
    if (statusTimer) clearInterval(statusTimer)
    statusTimer = null
  }

  function clear(): void {
    lines.value = []
  }

  onBeforeUnmount(() => {
    stopStream()
    engine.value?.stop()
    if (statusTimer) clearInterval(statusTimer)
  })

  return {
    ready,
    loading,
    progress,
    error,
    lines,
    model,
    backend,
    status,
    fedSeconds,
    tagRange,
    enable,
    disable,
    clear,
  }
}

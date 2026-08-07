import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import { ReceiveChain } from '@/core/dsp/demod'
import type { DemodMode } from '@/core/dsp/demod'
import { AudioSink } from '@/core/audio/AudioSink'
import type { Artifact, IqChunk } from '@/core/types'

/**
 * The listening path for any device that produces IQ.
 *
 * The driver emits IQ, this turns it into audio, and the audio sink plays it
 * and offers a tap so the transcriber can read the same samples without a
 * second demodulation.
 */
export function useReceiver(deviceId: string) {
  const mode = ref<DemodMode>('fm')
  const signalDb = ref(-120)
  const listening = ref(false)

  const chain = new ReceiveChain(48000)
  const sink = shallowRef<AudioSink | null>(null)
  let configuredRate = 0

  const stop = bus.onDeviceArtifact(deviceId, (a: Artifact) => {
    if (a.kind !== 'iq') return
    const chunk = a as IqChunk

    signalDb.value = signalDb.value * 0.8 + ReceiveChain.power(chunk.samples) * 0.2

    if (!listening.value || mode.value === 'raw') return

    if (chunk.sampleRate !== configuredRate) {
      configuredRate = chunk.sampleRate
      chain.configure(mode.value, chunk.sampleRate)
    }

    const audio = chain.process(chunk.samples)
    if (audio.length) sink.value?.push(audio, 48000)
  })

  function setMode(next: DemodMode): void {
    mode.value = next
    applyMode(next)
  }

  function applyMode(next: DemodMode): void {
    if (configuredRate) chain.configure(next, configuredRate)
  }

  async function start(): Promise<void> {
    if (!sink.value) sink.value = new AudioSink()
    // playback needs the gesture that started it, so resume before streaming.
    await sink.value.resume()
    listening.value = true
    await bus.start(deviceId, 'iq')
  }

  async function halt(): Promise<void> {
    listening.value = false
    try {
      await bus.stop(deviceId)
    } catch {
      // already stopped or the device went away.
    }
  }

  function setVolume(v: number): void {
    sink.value?.setVolume(v)
  }

  onBeforeUnmount(() => {
    stop()
    void sink.value?.close()
  })

  return { mode, signalDb, listening, sink, setMode, applyMode, start, stop: halt, setVolume }
}

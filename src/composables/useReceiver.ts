import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import { MODE_BANDWIDTH, ReceiveChain } from '@/core/dsp/demod'
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
  /** Where inside the tuned window we are listening, in Hz from its centre. */
  const offsetHz = ref(0)
  const bandwidthHz = ref(MODE_BANDWIDTH.fm)
  /** The window the device is currently handing over, so the panel can scale. */
  const windowHz = ref(0)

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
      windowHz.value = chunk.sampleRate
      chain.configure(mode.value, chunk.sampleRate, bandwidthHz.value)
      chain.setOffset(offsetHz.value)
      readBack()
    }

    const audio = chain.process(chunk.samples)
    if (audio.length) {
      sink.value?.push(audio, 48000)
      // the same audio re-enters the bus so the transcriber and the recorder
      // receive it, since the demodulation happened here rather than in the
      // driver. a fresh copy, because the sink keeps a reference to play.
      bus.emitAudio(deviceId, audio.slice(), 48000)
    }
  })

  function setMode(next: DemodMode): void {
    mode.value = next
    // each mode listens through a different width, so a mode change resets it
    // unless the width was already narrowed by hand.
    bandwidthHz.value = MODE_BANDWIDTH[next]
    applyMode(next)
  }

  function applyMode(next: DemodMode): void {
    if (!configuredRate) return
    chain.configure(next, configuredRate, bandwidthHz.value)
    chain.setOffset(offsetHz.value)
    readBack()
  }

  /** The chain clamps what it is given, so the refs follow what it settled on. */
  function readBack(): void {
    offsetHz.value = chain.offsetHz
    bandwidthHz.value = chain.bandwidthHz
  }

  /** Move the listening point inside the window, without retuning the radio. */
  function setOffset(hz: number): void {
    offsetHz.value = hz
    if (!configuredRate) return
    chain.setOffset(hz)
    readBack()
  }

  function setBandwidth(hz: number): void {
    bandwidthHz.value = hz
    if (!configuredRate) return
    chain.setBandwidth(hz)
    readBack()
  }

  async function start(): Promise<void> {
    if (!sink.value) sink.value = new AudioSink()
    // playback needs the gesture that started it, so resume before streaming.
    await sink.value.resume()
    listening.value = true
    await bus.start(deviceId, 'iq')
  }

  async function halt(): Promise<void> {
    // stop only what this panel started. leaving the tune tab used to stop
    // whatever else was running, and the unawaited call landed after the next
    // panel had already started, killing it.
    if (!listening.value) return
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

  return {
    mode,
    signalDb,
    listening,
    sink,
    offsetHz,
    bandwidthHz,
    windowHz,
    setMode,
    applyMode,
    setOffset,
    setBandwidth,
    start,
    stop: halt,
    setVolume,
  }
}

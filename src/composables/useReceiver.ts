import { onBeforeUnmount, ref, shallowRef } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import { MODE_BANDWIDTH, ReceiveChain } from '@/core/dsp/demod'
import type { DemodMode } from '@/core/dsp/demod'
import { AudioSink } from '@/core/audio/AudioSink'
import type { Artifact, IqChunk } from '@/core/types'

/** IQ chunks land far faster than a display can use, so the level is paced. */
const LEVEL_PUBLISH_MS = 20
/** A jump this size is a retune or a carrier, and goes out without waiting. */
const LEVEL_STEP_DB = 3

/**
 * The listening path for any device that produces IQ.
 *
 * The driver emits IQ, this turns it into audio, and the audio sink plays it.
 */
export interface ReceiverOptions {
  /**
   * Start and stop the device's stream with listening. A panel that holds
   * the stream another way, such as through a stream lease, passes false so
   * listening never stops a stream it did not start.
   */
  ownsStream?: boolean
}

export function useReceiver(deviceId: string, opts: ReceiverOptions = {}) {
  const ownsStream = opts.ownsStream ?? true
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
  let smoothDb = -120
  let publishedAt = 0

  const stop = bus.onDeviceArtifact(deviceId, (a: Artifact) => {
    if (a.kind !== 'iq') return
    const chunk = a as IqChunk

    smoothDb = smoothDb * 0.8 + ReceiveChain.power(chunk.samples) * 0.2
    const at = performance.now()
    const moved = Math.abs(smoothDb - signalDb.value) > LEVEL_STEP_DB
    if (moved || at - publishedAt >= LEVEL_PUBLISH_MS) {
      publishedAt = at
      signalDb.value = smoothDb
    }

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
    // each mode listens through a different width, so the width follows it.
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
    if (ownsStream) await bus.start(deviceId, 'iq')
  }

  async function halt(): Promise<void> {
    // bus.stop takes the whole device down, so a panel that is not listening
    // must not call it, another panel may be streaming.
    if (!listening.value) return
    listening.value = false
    if (!ownsStream) return
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

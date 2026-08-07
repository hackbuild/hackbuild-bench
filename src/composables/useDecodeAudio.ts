import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import { useReceiver } from '@/composables/useReceiver'
import { useDevices } from '@/stores/devices'
import { isSimKind } from '@/core/drivers/sim/simulate'
import type { DemodMode } from '@/core/dsp/demod'
import type { Artifact, AudioChunk } from '@/core/types'
import type { DemoAudioSource } from '@/core/decode/demo'

/**
 * The audio side of a decoder panel.
 *
 * Two things can feed a decoder. A radio that produces IQ goes through the
 * receive chain and the decoder taps the same samples the speakers get, so
 * audio is demodulated once. A device that already emits audio artifacts is
 * read straight off the bus.
 *
 * A simulated device has nothing on the air, so when one is focused the panel
 * runs a synthetic transmission through the same decoder instead. The demo
 * feeds faster than real time, which is why a ten minute satellite pass
 * finishes while you are still looking at it.
 */

export interface DecodeAudioOptions {
  /** Demodulation the mode being decoded needs. */
  mode: DemodMode
  onAudio: (samples: Float32Array, sampleRate: number) => void
  /** Built on start when the device is simulated. */
  demo?: () => DemoAudioSource
  /** How much faster than real time the demo runs. */
  demoSpeed?: number
}

const TICK_MS = 25
/** Cap on one block, so a tab that was throttled does not decode a huge burst. */
const MAX_CHUNK_MS = 3000

export function useDecodeAudio(deviceId: string, opts: DecodeAudioOptions) {
  const devices = useDevices()
  const rx = useReceiver(deviceId)

  const live = ref(false)
  const demoRunning = ref(false)
  const demoProgress = ref(0)
  const muted = ref(false)
  const error = ref<string | null>(null)

  const node = computed(() => devices.nodes.find((n) => n.id === deviceId) ?? null)
  const isSim = computed(() => (node.value ? isSimKind(node.value.kind) : false))
  const running = computed(() => live.value || demoRunning.value)

  let untap: (() => void) | null = null
  let timer = 0
  let source: DemoAudioSource | null = null

  const stopBus = bus.onDeviceArtifact(deviceId, (a: Artifact) => {
    if (a.kind !== 'audio' || !live.value) return
    const chunk = a as AudioChunk
    opts.onAudio(chunk.samples, chunk.sampleRate)
  })

  watch(
    rx.sink,
    (sink) => {
      untap?.()
      untap = null
      if (sink) {
        sink.setMuted(muted.value)
        untap = sink.tap((samples, rate) => opts.onAudio(samples, rate))
      }
    },
    { immediate: true },
  )

  function stopDemo(): void {
    if (timer) clearInterval(timer)
    timer = 0
    source = null
    demoRunning.value = false
  }

  function startDemo(): void {
    if (!opts.demo) return
    stopDemo()
    source = opts.demo()
    demoProgress.value = 0
    demoRunning.value = true
    const speed = Math.max(1, opts.demoSpeed ?? 8)
    // the block is sized from the clock rather than the tick, so a browser
    // that throttles timers in a background tab still runs at the same speed.
    let last = performance.now()
    timer = window.setInterval(() => {
      const src = source
      if (!src) return
      const now = performance.now()
      const chunk = Math.min(MAX_CHUNK_MS, (now - last) * speed)
      last = now
      if (chunk <= 0) return
      const block = src.read(chunk)
      if (block.length) opts.onAudio(block, src.sampleRate)
      demoProgress.value = src.progress
      if (src.done) stopDemo()
    }, TICK_MS)
  }

  async function start(): Promise<void> {
    error.value = null
    if (isSim.value && opts.demo) {
      startDemo()
      return
    }
    try {
      rx.setMode(opts.mode)
      await rx.start()
      live.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      live.value = false
    }
  }

  async function stop(): Promise<void> {
    stopDemo()
    if (!live.value) return
    live.value = false
    await rx.stop()
  }

  function setMuted(next: boolean): void {
    muted.value = next
    rx.sink.value?.setMuted(next)
  }

  onBeforeUnmount(() => {
    stopBus()
    untap?.()
    stopDemo()
    void rx.stop()
  })

  return {
    isSim,
    live,
    running,
    demoRunning,
    demoProgress,
    muted,
    error,
    signalDb: rx.signalDb,
    start,
    stop,
    setMuted,
  }
}

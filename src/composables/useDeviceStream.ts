import { onBeforeUnmount, ref, shallowRef, computed } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import type {
  Artifact,
  AudioChunk,
  DeviceNode,
  FftFrame,
  IqChunk,
  LineRecord,
  PacketRecord,
  Reading,
} from '@/core/types'

/**
 * Subscribes a panel to one device's artifact stream.
 *
 * Sample buffers are held in shallowRefs and replaced wholesale, so Vue never
 * walks a Float32Array. Anything that arrives faster than the screen refreshes
 * overwrites the previous value rather than queueing.
 */
export function useDeviceStream(deviceId: string) {
  const fft = shallowRef<Float32Array | null>(null)
  const iq = shallowRef<Float32Array | null>(null)
  const centerHz = ref(0)
  const sampleRate = ref(0)
  const powerDb = ref(-120)
  const droppedSamples = ref(0)

  const packets = ref<PacketRecord[]>([])
  const lines = ref<LineRecord[]>([])
  const readings = ref<Record<string, Reading>>({})

  const packetCount = ref(0)
  const lastAudio = shallowRef<AudioChunk | null>(null)

  const MAX_PACKETS = 400
  const MAX_LINES = 800

  const stop = bus.onDeviceArtifact(deviceId, (a: Artifact) => {
    switch (a.kind) {
      case 'fft': {
        const f = a as FftFrame
        fft.value = f.bins
        centerHz.value = f.centerHz
        sampleRate.value = f.sampleRate
        break
      }
      case 'iq': {
        const c = a as IqChunk
        iq.value = c.samples
        centerHz.value = c.centerHz
        sampleRate.value = c.sampleRate
        droppedSamples.value += c.dropped
        break
      }
      case 'audio':
        lastAudio.value = a as AudioChunk
        break
      case 'packet': {
        packetCount.value++
        packets.value = [a as PacketRecord, ...packets.value].slice(0, MAX_PACKETS)
        break
      }
      case 'line': {
        lines.value = [...lines.value, a as LineRecord].slice(-MAX_LINES)
        break
      }
      case 'reading': {
        const r = a as Reading
        readings.value = { ...readings.value, [r.name]: r }
        break
      }
      default:
        break
    }
  })

  onBeforeUnmount(stop)

  function clearPackets(): void {
    packets.value = []
    packetCount.value = 0
  }

  function clearLines(): void {
    lines.value = []
  }

  return {
    fft,
    iq,
    centerHz,
    sampleRate,
    powerDb,
    droppedSamples,
    packets,
    packetCount,
    lines,
    readings,
    lastAudio,
    clearPackets,
    clearLines,
  }
}

/** Reads one device node reactively and gives panels its params and status. */
export function useDeviceNode(deviceId: string, nodes: () => DeviceNode[]) {
  const node = computed(() => nodes().find((n) => n.id === deviceId) ?? null)
  const streaming = computed(() => node.value?.status === 'streaming')
  const params = computed(() => node.value?.params ?? {})
  return { node, streaming, params }
}

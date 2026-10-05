import { computed, onBeforeUnmount, watch } from 'vue'
import { useDevices } from '@/stores/devices'

/**
 * A decoder panel's hold on a device's stream.
 *
 * Starting takes several awaits, a tune and then the stream, and the panel
 * can be stopped or unmounted in between. Each start therefore gets a token,
 * and a panel checks it after every await: a stale token means stop already
 * ran, and anything the late start did is undone here instead of being left
 * running with nobody owning it.
 *
 * Tabs mount one at a time, so the panel being left and the panel being
 * opened overlap for a moment. The old one's stop can land after the new one
 * found the stream running and took it as it was. A panel that still wants
 * the stream starts it again when that happens, and owns it from then on.
 */
export function useStreamLease(deviceId: string, mode = 'iq') {
  const devices = useDevices()
  const node = computed(() => devices.nodes.find((n) => n.id === deviceId) ?? null)

  let token = 0
  let wanted = false
  let owns = false
  let disposed = false

  /** Starts a hold. Pass the returned token to `current` after each await. */
  function begin(): number {
    wanted = true
    return ++token
  }

  /** False once stop, unmount or a newer start has superseded this one. */
  function current(t: number): boolean {
    return !disposed && wanted && t === token
  }

  /**
   * Makes sure the stream runs, starting it when nothing else has. False when
   * the hold went stale meanwhile, in which case a stream started here is
   * stopped again before returning.
   */
  async function stream(t: number): Promise<boolean> {
    if (!current(t)) return false
    if (node.value?.status !== 'streaming') {
      await devices.start(deviceId, mode)
      if (!current(t)) {
        await devices.stop(deviceId).catch(() => undefined)
        return false
      }
      owns = true
    }
    return true
  }

  /** Ends the hold, stopping the stream only when this panel started it. */
  async function release(): Promise<void> {
    wanted = false
    token++
    if (!owns) return
    owns = false
    try {
      await devices.stop(deviceId)
    } catch {
      // already stopped or the device went away.
    }
  }

  watch(
    () => node.value?.status,
    (status) => {
      if (!wanted || disposed || status !== 'idle') return
      const t = token
      void devices
        .start(deviceId, mode)
        .then(() => {
          if (current(t)) owns = true
          else void devices.stop(deviceId).catch(() => undefined)
        })
        .catch(() => undefined)
    },
  )

  onBeforeUnmount(() => {
    disposed = true
    void release()
  })

  return { begin, current, stream, release, owns: () => owns }
}

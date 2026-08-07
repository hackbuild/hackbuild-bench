import { computed, ref } from 'vue'
import { bus } from '@/core/bus/DeviceBus'
import { SIM_DRIVERS } from '@/core/drivers/registry'
import { isSimKind } from '@/core/drivers/sim/simulate'
import { useDevices } from '@/stores/devices'
import { useBench } from '@/stores/bench'

const busy = ref(false)

/**
 * Demo mode fills the bench with a simulated copy of every device, so the
 * whole app can be used with nothing plugged in. Turning it off detaches only
 * the simulated ones and leaves real hardware alone.
 */
export function useDemoMode() {
  const devices = useDevices()
  const bench = useBench()

  const on = computed(() => devices.nodes.some((n) => isSimKind(n.kind)))

  async function enable(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      for (const driver of SIM_DRIVERS) {
        const kind = driver.descriptor.kind
        if (devices.nodes.some((n) => n.kind === kind)) continue
        const handle = await driver.requestAccess('sim')
        if (handle) await bus.attach(handle)
      }
      devices.sync()
      const first = devices.nodes.find((n) => isSimKind(n.kind))
      if (first) devices.focus(first.id)
      bench.setView('rack')
    } finally {
      busy.value = false
    }
  }

  async function disable(): Promise<void> {
    if (busy.value) return
    busy.value = true
    try {
      const simIds = devices.nodes.filter((n) => isSimKind(n.kind)).map((n) => n.id)
      for (const id of simIds) await devices.disconnect(id)
    } finally {
      busy.value = false
    }
  }

  async function toggle(): Promise<void> {
    if (on.value) await disable()
    else await enable()
  }

  return { on, busy, enable, disable, toggle }
}

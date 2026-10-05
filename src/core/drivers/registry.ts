import { bus } from '../bus/DeviceBus'
import type { DeviceDriver } from './types'
import { makeSimDriver } from './sim/simulate'

import { rtlsdrDriver } from './rtlsdr'
import { hackrfDriver } from './hackrf'
import { ubertoothDriver } from './ubertooth'
import { esp32Driver } from './esp32'
import { conduytDriver } from './conduyt'
import { meshtasticDriver } from './meshtastic'
import { pineappleDriver } from './pineapple'
import { iqFileDriver } from './iqfile'

/**
 * Every driver the bench knows about.
 *
 * Adding hardware is one entry here plus one folder implementing the adapter
 * contract. A simulated twin is generated from the descriptor, so a new device
 * works in demo mode without any extra code.
 */
export const DRIVERS: DeviceDriver[] = [
  rtlsdrDriver,
  hackrfDriver,
  ubertoothDriver,
  conduytDriver,
  esp32Driver,
  meshtasticDriver,
  pineappleDriver,
  iqFileDriver,
]

/**
 * One simulated twin per real driver, in the same order. A recording is
 * already a stand-in for a radio, so it has none.
 */
export const SIM_DRIVERS: DeviceDriver[] = DRIVERS.filter(
  (d) => !d.descriptor.transports.includes('file'),
).map(makeSimDriver)

let installed = false

export function installDrivers(): void {
  if (installed) return
  for (const d of DRIVERS) bus.registerDriver(d)
  for (const d of SIM_DRIVERS) bus.registerDriver(d)
  installed = true
}

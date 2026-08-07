import { bus } from '../bus/DeviceBus'
import type { DeviceDriver } from './types'

import { rtlsdrDriver } from './rtlsdr'
import { hackrfDriver } from './hackrf'
import { ubertoothDriver } from './ubertooth'
import { esp32Driver } from './esp32'
import { meshtasticDriver } from './meshtastic'
import { pineappleDriver } from './pineapple'
import { simDriver } from './sim'

/**
 * Every driver the bench knows about.
 *
 * Adding hardware is one entry here plus one folder implementing the adapter
 * contract. Nothing else in the tree changes.
 */
export const DRIVERS: DeviceDriver[] = [
  rtlsdrDriver,
  hackrfDriver,
  ubertoothDriver,
  esp32Driver,
  meshtasticDriver,
  pineappleDriver,
  simDriver,
]

let installed = false

export function installDrivers(): void {
  if (installed) return
  for (const d of DRIVERS) bus.registerDriver(d)
  installed = true
}

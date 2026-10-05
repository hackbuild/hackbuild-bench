import type { IsmProtocol } from './types'
import { acuriteTxr } from './protocols/acurite'
import { lacrosseTx141 } from './protocols/lacrosse'
import { ambientF007th } from './protocols/ambient'
import { fineoffsetWh2, fineoffsetWh25 } from './protocols/fineoffset'
import { oregonScientific } from './protocols/oregon'
import { nexus, prologue } from './protocols/nexus'
import { genericRemote } from './protocols/remote'
import { schrader, toyota } from './protocols/tpms'

/**
 * Every protocol the ism decoder runs.
 *
 * A protocol is one module exporting an `IsmProtocol`. Adding one is a new
 * file under `protocols/` and one entry here. The decoder reads only this
 * list, and dispatches by each protocol's modulation. The order follows
 * rtl_433's protocol numbers, so messages come out in the order it prints them.
 */
const PROTOCOLS: IsmProtocol[] = [
  prologue,
  oregonScientific,
  fineoffsetWh2,
  nexus,
  ambientF007th,
  genericRemote,
  acuriteTxr,
  schrader,
  lacrosseTx141,
  fineoffsetWh25,
  toyota,
]

export function registerIsmProtocol(p: IsmProtocol): void {
  if (PROTOCOLS.some((q) => q.id === p.id)) throw new Error(`ism protocol ${p.id} is already registered`)
  PROTOCOLS.push(p)
}

export function ismProtocols(): readonly IsmProtocol[] {
  return PROTOCOLS
}

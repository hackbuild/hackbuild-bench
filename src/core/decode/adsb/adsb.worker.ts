import { AdsbDecoder, packetOf } from './index'
import type { AdsbPacket } from './index'
import type { FromWorker, ToWorker } from './protocol'

/**
 * The decoder on its own thread. On plain receiver noise about one sample in
 * a hundred passes the preamble test and is sliced five ways, which in a
 * browser costs around a quarter of a core at 2.4 Msps.
 */

interface Scope {
  postMessage(message: FromWorker): void
  onmessage: ((e: MessageEvent<ToWorker>) => void) | null
}

const scope = self as unknown as Scope
const decoder = new AdsbDecoder()
let batch: AdsbPacket[] = []
let consumed = 0
decoder.onMessage = (d) => batch.push(packetOf(d))

scope.onmessage = (e) => {
  const msg = e.data
  switch (msg.type) {
    case 'feed':
      decoder.feed(msg.iq, msg.rate, msg.dropped)
      consumed += msg.iq.length >> 1
      if (batch.length) {
        scope.postMessage({ type: 'packets', packets: batch })
        batch = []
      }
      break
    case 'receiver':
      decoder.receiver = msg.at
      break
    case 'reset':
      decoder.reset()
      break
    case 'snapshot':
      decoder.prune()
      scope.postMessage({
        type: 'snapshot',
        aircraft: decoder.snapshot(),
        messages: decoder.messages,
        repaired: decoder.repaired,
        preambles: decoder.preambles,
        consumed,
        now: decoder.now(),
      })
      break
  }
}

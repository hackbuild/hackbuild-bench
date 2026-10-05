import type { AdsbPacket, Aircraft, LatLon } from './index'

/** Messages to the decoder worker. */
export type ToWorker =
  | { type: 'feed'; iq: Float32Array; rate: number; dropped: number }
  | { type: 'receiver'; at: LatLon | null }
  | { type: 'snapshot' }
  | { type: 'reset' }

/** Messages from the decoder worker. */
export type FromWorker =
  | { type: 'packets'; packets: AdsbPacket[] }
  | {
      type: 'snapshot'
      aircraft: Aircraft[]
      messages: number
      repaired: number
      preambles: number
      /** Samples decoded so far, so the sender can tell how far behind it is. */
      consumed: number
      /** The decoder's sample clock, in ms. */
      now: number
    }

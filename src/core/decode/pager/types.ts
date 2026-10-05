export type PagerProto = 'pocsag' | 'flex'

/** How a page's body was read. */
export type PagerKind = 'alpha' | 'numeric' | 'tone' | 'binary' | 'group'

/** One decoded page, whichever protocol carried it. */
export interface PagerMessage {
  id: string
  /** Wall clock ms when the last word of it arrived. */
  at: number
  proto: PagerProto
  /** Data rate in bits per second: 512, 1200, 2400 for POCSAG, 1600 to 6400 for FLEX. */
  baud: number
  /** FSK levels, 2 for POCSAG and 2 or 4 for FLEX. */
  levels: 2 | 4
  /** POCSAG address or FLEX capcode. */
  address: number
  /**
   * POCSAG function bits, 0 to 3. FLEX has none, so for FLEX this is the
   * vector type: 2 tone or short numeric, 3 numeric, 5 alphanumeric, and so on.
   */
  func: number
  kind: PagerKind
  /** The body with control characters dropped, empty for a tone only page. */
  text: string
  /** Every address a FLEX group page reached, when it was one. */
  group?: number[]
  /** FLEX cycle and frame, which together give the time within the hour. */
  cycle?: number
  frame?: number
  /** FLEX phase, A to D. */
  phase?: string
  /** True when part of the page was lost: a fragment that never completed or a bad word. */
  partial?: boolean
  /** Bits the code corrected across the page's words. */
  corrected: number
  /** POCSAG only, the body read the other way, since function bits do not fix the format. */
  alt?: string
}

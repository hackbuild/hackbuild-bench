import type { TransportKind } from '../types'

/**
 * What this browser can actually reach. The connect UI reads this and says
 * plainly which transports are missing rather than offering a device that
 * cannot open.
 */
export interface TransportSupport {
  kind: TransportKind
  available: boolean
  /** Why it is unavailable, in the words shown to the user. */
  reason?: string
}

const SECURE = typeof window !== 'undefined' && window.isSecureContext

function check(present: boolean, missing: string): { available: boolean; reason?: string } {
  if (!SECURE) {
    return { available: false, reason: 'needs https or localhost' }
  }
  if (!present) {
    return { available: false, reason: missing }
  }
  return { available: true }
}

export function transportSupport(): Record<TransportKind, TransportSupport> {
  const nav = typeof navigator === 'undefined' ? ({} as Navigator) : navigator
  const chromium = 'chrome only, try chrome, edge, or opera'

  return {
    webusb: { kind: 'webusb', ...check('usb' in nav, chromium) },
    webserial: { kind: 'webserial', ...check('serial' in nav, chromium) },
    webble: { kind: 'webble', ...check('bluetooth' in nav, chromium) },
    webhid: { kind: 'webhid', ...check('hid' in nav, chromium) },
    http: {
      kind: 'http',
      available: true,
      reason: SECURE && location.protocol === 'https:'
        ? 'an https page cannot call a plain http appliance. serve this app over http on localhost to reach it.'
        : undefined,
    },
    sim: { kind: 'sim', available: true },
  }
}

export function hasWebGPU(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

import { bus } from '@/core/bus/DeviceBus'
import type { ArtifactDraft } from '@/core/types'

/** Publishes a decoded packet or reading under the device that heard it. */
export function emitArtifact(
  deviceId: string,
  draft: Extract<ArtifactDraft, { kind: 'packet' | 'reading' }>,
): void {
  bus.emitDecoded(deviceId, draft)
}

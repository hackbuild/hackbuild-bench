import type { Component } from 'vue'
import type { Capability } from '@/core/capabilities'

/**
 * A tool is one panel of capability. Tools are how the bench grows.
 *
 * A device tool mounts inside a device's control plane and appears only when
 * that device provides the capabilities it declares. A bench tool stands on
 * its own in the rail and can pull from any provider on the bus.
 *
 * Adding a tool is one manifest plus one component. Nothing else in the tree
 * changes, and no switch statement anywhere is keyed on device kind.
 */

export type ToolScope = 'device' | 'bench'

export interface ToolManifest {
  /** Unique. Also the sub-tab key and the route segment. */
  id: string
  /** Sub-tab label. Lowercase, terse. */
  label: string
  /** Font Awesome icon name, without the fa- prefix. */
  icon: string
  scope: ToolScope

  /**
   * Capabilities a device must provide for this tool to appear in its plane.
   * Empty means the tool appears on every device, which is what the log and
   * device info panels want.
   */
  requires: Capability[]

  /**
   * Restrict to specific device kinds. Prefer requires. Use this only when a
   * panel is genuinely hardware specific, such as the Ubertooth register bench
   * or the ESP32 pin grid, where no capability string would be honest.
   */
  onlyKinds?: string[]

  /** Hide behind the advanced toggle. */
  advanced?: boolean

  /** The panel. Receives a deviceId prop for device tools. */
  component: Component

  /** Order within the plane. Lower sorts first. */
  order?: number

  /**
   * For bench tools, the subtitle shown under the name in the rail.
   * For device tools this is unused.
   */
  blurb?: string
}

export interface DeviceToolProps {
  deviceId: string
}

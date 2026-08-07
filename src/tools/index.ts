import { CAPABILITIES } from '@/core/capabilities'
import { registerTools } from './registry'
import type { ToolManifest } from './types'

import ReceiverPanel from './receiver/ReceiverPanel.vue'
import SpectrumPanel from './spectrum/SpectrumPanel.vue'
import GhostBoxPanel from './ghostbox/GhostBoxPanel.vue'
import ScannerPanel from './scanner/ScannerPanel.vue'
import SnifferPanel from './sniffer/SnifferPanel.vue'
import TerminalPanel from './terminal/TerminalPanel.vue'
import MeshPanel from './mesh/MeshPanel.vue'
import SurveyPanel from './survey/SurveyPanel.vue'
import ConduytPanel from './conduyt/ConduytPanel.vue'
import DeviceLogPanel from './log/DeviceLogPanel.vue'
import AnalysisPanel from './analysis/AnalysisPanel.vue'
import PlaybooksPanel from './playbooks/PlaybooksPanel.vue'
import AutomationsPanel from './automations/AutomationsPanel.vue'

/**
 * Every panel the bench can show.
 *
 * A device tool appears on any device providing the capabilities it names, so
 * a new radio gets the receiver, the spectrum, and the spirit box with no
 * change here. A bench tool stands alone in the rail.
 */
const TOOLS: ToolManifest[] = [
  {
    id: 'receiver',
    label: 'tune',
    icon: 'headphones',
    scope: 'device',
    requires: [CAPABILITIES.AUDIO_DEMOD],
    component: ReceiverPanel,
    order: 10,
  },
  {
    id: 'spectrum',
    label: 'spectrum',
    icon: 'wave-square',
    scope: 'device',
    requires: [CAPABILITIES.OBSERVE_SPECTRUM],
    component: SpectrumPanel,
    order: 20,
  },
  {
    id: 'scanner',
    label: 'scanner',
    icon: 'tower-cell',
    scope: 'device',
    requires: [CAPABILITIES.AUDIO_DEMOD],
    component: ScannerPanel,
    order: 25,
  },
  {
    id: 'ghostbox',
    label: 'ghost box',
    icon: 'ghost',
    scope: 'device',
    requires: [CAPABILITIES.AUDIO_DEMOD],
    component: GhostBoxPanel,
    order: 30,
  },
  {
    id: 'sniffer',
    label: 'sniffer',
    icon: 'satellite-dish',
    scope: 'device',
    requires: [CAPABILITIES.CAPTURE_PACKET],
    component: SnifferPanel,
    order: 40,
  },
  {
    id: 'mesh',
    label: 'mesh',
    icon: 'circle-nodes',
    scope: 'device',
    requires: [CAPABILITIES.MESH_RX],
    component: MeshPanel,
    order: 45,
  },
  {
    id: 'terminal',
    label: 'terminal',
    icon: 'terminal',
    scope: 'device',
    requires: [CAPABILITIES.SERIAL_CONSOLE],
    component: TerminalPanel,
    order: 50,
  },
  {
    id: 'conduyt',
    label: 'board',
    icon: 'microchip',
    scope: 'device',
    requires: [CAPABILITIES.GPIO_DRIVE],
    onlyKinds: ['conduyt', 'sim:conduyt'],
    component: ConduytPanel,
    order: 60,
  },
  {
    id: 'survey',
    label: 'survey',
    icon: 'wifi',
    scope: 'device',
    requires: [CAPABILITIES.NET_SURVEY],
    component: SurveyPanel,
    order: 70,
  },
  {
    id: 'devicelog',
    label: 'device',
    icon: 'list-check',
    scope: 'device',
    requires: [],
    component: DeviceLogPanel,
    order: 900,
  },

  {
    id: 'playbooks',
    label: 'playbooks',
    icon: 'list-check',
    scope: 'bench',
    requires: [],
    component: PlaybooksPanel,
    blurb: 'jobs the bench does for you',
    order: 5,
  },
  {
    id: 'analysis',
    label: 'analysis',
    icon: 'wand',
    scope: 'bench',
    requires: [],
    component: AnalysisPanel,
    blurb: 'recipe and magic',
    order: 10,
  },
  {
    id: 'automations',
    label: 'automations',
    icon: 'diagram-project',
    scope: 'bench',
    requires: [],
    component: AutomationsPanel,
    blurb: 'trigger, condition, action',
    order: 20,
  },
]

let installed = false

export function installTools(): void {
  if (installed) return
  registerTools(TOOLS)
  installed = true
}

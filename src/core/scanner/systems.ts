import type { ServiceTag } from './conventional'

/**
 * Trunked system data.
 *
 * A trunked system moves a conversation across a pool of frequencies. To
 * follow it you watch a control channel, read the grant that says which
 * frequency a talkgroup just moved to, and tune there. The data here is what
 * the app needs to do that: the control channel frequencies and the talkgroup
 * list with what each one is for.
 *
 * Only a small, confident set of systems ships with the app. The detailed
 * databases that hold every county do not permit redistribution, so the rest
 * is imported by the user. See importSystems below.
 */

export type SystemType = 'p25p1' | 'p25p2' | 'smartnet' | 'edacs' | 'dmr' | 'nxdn' | 'ltr'

export interface TalkgroupEntry {
  /** Decimal talkgroup id, the number a grant carries. */
  id: number
  name: string
  service: ServiceTag
  /** Set when the agency runs this group encrypted, so it will show but stay silent. */
  encrypted?: boolean
  /** The agency this group belongs to, for grouping in the list. */
  agency?: string
}

export interface Site {
  id: string
  name: string
  /** Control channel frequencies in Hz. The first that decodes is used. */
  controlHz: number[]
  county?: string
}

export interface RadioSystem {
  id: string
  name: string
  type: SystemType
  /** P25 system id and wide area comm network, when known, for identification. */
  sysId?: string
  wacn?: string
  nac?: number
  sites: Site[]
  talkgroups: TalkgroupEntry[]
  /** Set on every field the app is not confident about, shown to the user. */
  uncertain?: boolean
  /** Where this data came from, so the user can check it. */
  source?: string
}

export interface ScanList {
  id: string
  name: string
  /** Conventional channels by id and talkgroups by system plus tgid. */
  channelIds: string[]
  talkgroups: Array<{ systemId: string; tgid: number }>
}

// ---------------------------------------------------------------------------
// bundled systems. kept deliberately small and marked uncertain, because
// control channels and talkgroup assignments change and we cannot verify
// them from here. the app shows the uncertainty rather than pretending.
// ---------------------------------------------------------------------------

/**
 * Arizona statewide and Phoenix area systems. These are starting points a user
 * should confirm against a current source before relying on them, which is why
 * every one carries uncertain: true and a source link.
 *
 * Real, current control channel frequencies and talkgroup ids belong to
 * databases we cannot redistribute. The entries here carry the system identity
 * and the service structure so the import step has something to merge into,
 * and so the picker is not empty. Frequencies the user must confirm are left
 * out rather than guessed.
 */
export const BUNDLED_SYSTEMS: RadioSystem[] = [
  {
    id: 'az-wins',
    name: 'AZ WINS (DPS statewide, phoenix and tucson)',
    type: 'p25p2',
    sysId: '049',
    source: 'control channels verifiable in fcc uls, talkgroups from radioreference, confirm before relying',
    sites: [
      { id: 'south-mtn', name: 'South Mountain (Phoenix)', controlHz: [774.06875e6, 774.31875e6], county: 'Maricopa' },
      { id: 'thompson', name: 'Thompson Peak (Scottsdale)', controlHz: [774.09375e6, 774.34375e6], county: 'Maricopa' },
      { id: 'mt-lemmon', name: 'Mount Lemmon (Tucson)', controlHz: [770.16875e6, 770.41875e6], county: 'Pima' },
    ],
    talkgroups: [
      // dps highway patrol district dispatch, still in the clear
      { id: 1055, name: 'dps d5 metro central phoenix', service: 'law', agency: 'dps' },
      { id: 1058, name: 'dps d13 metro east phoenix', service: 'law', agency: 'dps' },
      { id: 1059, name: 'dps d14 metro west phoenix', service: 'law', agency: 'dps' },
      { id: 1060, name: 'dps d18 metro south phoenix', service: 'law', agency: 'dps' },
      { id: 1006, name: 'dps d8 tucson', service: 'law', agency: 'dps' },
      { id: 1052, name: 'dps d2 flagstaff', service: 'law', agency: 'dps' },
      { id: 1057, name: 'dps d12 prescott', service: 'law', agency: 'dps' },
      { id: 1017, name: 'dps metro west tac', service: 'law', agency: 'dps' },
      { id: 1018, name: 'dps metro east tac', service: 'law', agency: 'dps' },
      { id: 1049, name: 'psap north interop', service: 'interop', agency: 'statewide' },
      // medical helicopter flight following, clear
      { id: 485, name: 'lifenet 1 (florence)', service: 'ems', agency: 'air medical' },
      { id: 729, name: 'lifenet 2 (tucson)', service: 'ems', agency: 'air medical' },
    ],
  },
  {
    id: 'phoenix-rwc',
    name: 'Phoenix RWC (regional wireless cooperative)',
    type: 'p25p2',
    sysId: '534',
    wacn: 'BEE08',
    source: 'control channels verifiable in fcc uls, talkgroups from radioreference, confirm before relying',
    sites: [
      { id: 'sim-a', name: 'Simulcast A: Phoenix PD', controlHz: [771.68125e6, 771.79375e6, 772.04375e6, 772.18125e6], county: 'Maricopa' },
      { id: 'sim-b', name: 'Simulcast B: Phoenix Fire', controlHz: [770.83125e6, 771.13125e6, 771.18125e6, 771.43125e6], county: 'Maricopa' },
      { id: 'sim-h', name: 'Simulcast H: Scottsdale', controlHz: [771.09375e6, 771.34375e6, 771.59375e6, 771.84375e6], county: 'Maricopa' },
    ],
    talkgroups: [
      // phoenix fire dispatches most of the valley, clear phase 2
      { id: 1795, name: 'phoenix fire k1 alarm (dispatch)', service: 'fire', agency: 'phoenix fire' },
      { id: 1753, name: 'phoenix fire k2 tac', service: 'fire', agency: 'phoenix fire' },
      { id: 1786, name: 'phoenix fire k3 tac', service: 'fire', agency: 'phoenix fire' },
      { id: 1615, name: 'phoenix fire k6 north', service: 'fire', agency: 'phoenix fire' },
      { id: 1614, name: 'phoenix fire k7 east', service: 'fire', agency: 'phoenix fire' },
      { id: 1613, name: 'phoenix fire k8 south', service: 'fire', agency: 'phoenix fire' },
      { id: 1612, name: 'phoenix fire k9 west', service: 'fire', agency: 'phoenix fire' },
      // per city fire, e3 and e2 are clear
      { id: 1602, name: 'tempe fire e3', service: 'fire', agency: 'tempe fire' },
      { id: 1638, name: 'scottsdale fire e3', service: 'fire', agency: 'scottsdale fire' },
      { id: 1678, name: 'chandler fire e3', service: 'fire', agency: 'chandler fire' },
      { id: 1666, name: 'glendale fire e3', service: 'fire', agency: 'glendale fire' },
      // phoenix pd precinct dispatch, clear (tactical is encrypted)
      { id: 2811, name: 'phoenix pd black mountain precinct', service: 'law', agency: 'phoenix pd' },
      { id: 2996, name: 'phoenix pd south mountain precinct', service: 'law', agency: 'phoenix pd' },
      { id: 2995, name: 'phoenix pd central city precinct', service: 'law', agency: 'phoenix pd' },
      { id: 2992, name: 'phoenix pd maryvale estrella precinct', service: 'law', agency: 'phoenix pd' },
      // clear city pd dispatch
      { id: 2498, name: 'chandler pd patrol a', service: 'law', agency: 'chandler pd' },
      { id: 4301, name: 'surprise pd dispatch', service: 'law', agency: 'surprise pd' },
      { id: 3696, name: 'paradise valley pd dispatch', service: 'law', agency: 'paradise valley pd' },
      // regional interop, mostly clear
      { id: 1730, name: 'rwc g1 interop', service: 'interop', agency: 'regional' },
      { id: 1731, name: 'rwc g6 interop', service: 'interop', agency: 'regional' },
    ],
  },
  {
    id: 'topaz-trwc',
    name: 'TOPAZ TRWC (mesa and east valley)',
    type: 'p25p2',
    sysId: '36B',
    wacn: 'BEE00',
    source: 'control channels verifiable in fcc uls, talkgroups from radioreference, confirm before relying',
    sites: [
      { id: 'mesa-sim', name: 'Mesa Simulcast', controlHz: [852.75e6, 852.825e6, 853.275e6, 853.35e6], county: 'Maricopa' },
      { id: 'thompson-t', name: 'Thompson Peak', controlHz: [851.425e6, 852.0625e6, 852.775e6, 853.6375e6], county: 'Maricopa' },
    ],
    talkgroups: [
      // east valley fire is the most listenable set in the metro, all clear
      { id: 3064, name: 'east valley fire c1 dispatch', service: 'fire', agency: 'east valley fire' },
      { id: 3066, name: 'east valley fire c3 mesa', service: 'fire', agency: 'mesa fire' },
      { id: 3067, name: 'east valley fire c4 gilbert queen creek', service: 'fire', agency: 'gilbert fire' },
      { id: 3070, name: 'east valley fire c7 safety', service: 'fire', agency: 'east valley fire' },
      { id: 3601, name: 'fort mcdowell fire', service: 'fire', agency: 'fort mcdowell' },
      { id: 3899, name: 'fire multi agency', service: 'fire', agency: 'regional' },
      // mutual aid, clear
      { id: 3044, name: 'mesa gilbert pd fd link', service: 'interop', agency: 'regional' },
      { id: 3804, name: 'mesa gilbert pd channel a', service: 'law', agency: 'regional' },
    ],
  },
  {
    id: 'pcwin',
    name: 'PCWIN (tucson and pima county)',
    type: 'p25p2',
    source: 'control channels verifiable in fcc uls, talkgroups from radioreference, confirm before relying',
    sites: [
      { id: 'metro-a', name: 'Simulcast A (Metro Tucson)', controlHz: [853.375e6, 853.625e6, 853.7125e6, 853.9e6], county: 'Pima' },
      { id: 'metro-b', name: 'Simulcast B (Metro Tucson)', controlHz: [853.5375e6, 853.65e6, 853.85e6, 853.925e6], county: 'Pima' },
    ],
    talkgroups: [
      // tucson fire, all clear
      { id: 15001, name: 'tucson fire a2 dispatch', service: 'fire', agency: 'tucson fire' },
      { id: 15000, name: 'tucson fire a1 emergency', service: 'fire', agency: 'tucson fire' },
      { id: 15010, name: 'tucson fire b2 inbound', service: 'fire', agency: 'tucson fire' },
      { id: 15006, name: 'tucson fire a3 north', service: 'fire', agency: 'tucson fire' },
      { id: 15007, name: 'tucson fire a4 south', service: 'fire', agency: 'tucson fire' },
    ],
  },
  {
    id: 'maricopa-mcso',
    name: 'Maricopa County Sheriff',
    type: 'p25p2',
    source: 'control channels verifiable in fcc uls, talkgroups from radioreference, confirm before relying',
    sites: [
      { id: 'chandler-mesa', name: 'Chandler/Mesa Simulcast', controlHz: [771.33125e6, 771.49375e6, 771.70625e6, 771.83125e6], county: 'Maricopa' },
      { id: 'childs-mtn', name: 'Childs Mountain (Pima)', controlHz: [769.50625e6, 769.75625e6, 770.00625e6, 770.25625e6], county: 'Pima' },
    ],
    talkgroups: [
      // mcso district dispatch is clear
      { id: 1044, name: 'mcso special details', service: 'law', agency: 'mcso' },
      { id: 5901, name: 'mcso internal ops', service: 'law', agency: 'mcso' },
    ],
  },
]

/**
 * User imported systems, kept in local storage. Merged with the bundled ones
 * for the picker.
 */
const STORAGE_KEY = 'hackbuild.scanner.systems'

export function loadImportedSystems(): RadioSystem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as RadioSystem[]) : []
  } catch {
    return []
  }
}

export function saveImportedSystems(systems: RadioSystem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(systems))
  } catch {
    // private browsing, the import just does not persist across sessions.
  }
}

export function allSystems(): RadioSystem[] {
  return [...BUNDLED_SYSTEMS, ...loadImportedSystems()]
}

export function systemById(id: string): RadioSystem | undefined {
  return allSystems().find((s) => s.id === id)
}

/**
 * Import a system from pasted text. Accepts the app's own JSON export, and a
 * simple csv the user can build from a radioreference talkgroup table:
 * decimal, name, service, agency per line. The frequencies come from a
 * separate control channel field the user fills in the panel.
 */
export function importSystems(text: string): { systems: RadioSystem[]; error?: string } {
  const trimmed = text.trim()
  if (!trimmed) return { systems: [], error: 'paste something first' }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      return { systems: arr as RadioSystem[] }
    } catch {
      return { systems: [], error: 'that looked like json but did not parse' }
    }
  }

  // csv: one talkgroup per line, becomes a single imported system.
  const rows = trimmed.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'))
  const talkgroups: TalkgroupEntry[] = []
  for (const row of rows) {
    const [dec, name, service, agency] = row.split(',').map((c) => c.trim())
    const id = Number(dec)
    if (!Number.isFinite(id) || !name) continue
    talkgroups.push({
      id,
      name,
      service: (service as ServiceTag) || 'other',
      agency: agency || undefined,
    })
  }
  if (!talkgroups.length) {
    return { systems: [], error: 'no rows parsed. expected decimal, name, service, agency per line' }
  }
  return {
    systems: [
      {
        id: `imported-${talkgroups[0].id}`,
        name: 'imported talkgroups',
        type: 'p25p2',
        uncertain: true,
        source: 'user import',
        sites: [],
        talkgroups,
      },
    ],
  }
}

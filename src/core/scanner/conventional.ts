/**
 * Conventional channels that are published nationally and do not change.
 *
 * These are the interoperability channels from the national field operations
 * guide plus the weather, marine, aviation, and licence-free services. They
 * are the same everywhere in the United States, so they ship with the app.
 *
 * Local agency frequencies are NOT here. Those vary by county and are the
 * user's to import, because the databases that hold them do not allow
 * redistribution.
 */

export type ServiceTag =
  | 'interop'
  | 'fire'
  | 'law'
  | 'ems'
  | 'weather'
  | 'marine'
  | 'aviation'
  | 'railroad'
  | 'ham'
  | 'unlicensed'
  | 'other'

export type ChannelMode = 'nfm' | 'fm' | 'am' | 'p25' | 'dmr'

export interface ConventionalChannel {
  id: string
  name: string
  /** Receive frequency in Hz. */
  hz: number
  mode: ChannelMode
  service: ServiceTag
  /** What you would actually hear, in plain words. */
  note?: string
  /** CTCSS tone in Hz where the national plan specifies one. */
  toneHz?: number
}

export interface ChannelGroup {
  id: string
  name: string
  blurb: string
  service: ServiceTag
  channels: ConventionalChannel[]
}

const ch = (
  id: string,
  name: string,
  hz: number,
  service: ServiceTag,
  note?: string,
  mode: ChannelMode = 'nfm',
  toneHz?: number,
): ConventionalChannel => ({ id, name, hz, mode, service, note, toneHz })

/**
 * The national interoperability channels. Every agency in the country is
 * supposed to be able to work these, so they are the first thing worth
 * listening to in an unfamiliar place. Tone 156.7 is the national plan value
 * for the VHF and UHF interop repeaters.
 */
export const INTEROP: ChannelGroup = {
  id: 'interop',
  name: 'national interop',
  blurb: 'the channels every agency can work, used when several of them turn up together',
  service: 'interop',
  channels: [
    ch('vcall10', 'VCALL10', 155.7525e6, 'interop', 'vhf calling, where agencies meet before moving to a tac', 'nfm', 156.7),
    ch('vtac11', 'VTAC11', 151.1375e6, 'interop', 'vhf tactical', 'nfm', 156.7),
    ch('vtac12', 'VTAC12', 154.4525e6, 'interop', 'vhf tactical', 'nfm', 156.7),
    ch('vtac13', 'VTAC13', 158.7375e6, 'interop', 'vhf tactical', 'nfm', 156.7),
    ch('vtac14', 'VTAC14', 159.4725e6, 'interop', 'vhf tactical', 'nfm', 156.7),
    ch('ucall40', 'UCALL40', 453.2125e6, 'interop', 'uhf calling', 'nfm', 156.7),
    ch('utac41', 'UTAC41', 453.4625e6, 'interop', 'uhf tactical', 'nfm', 156.7),
    ch('utac42', 'UTAC42', 453.7125e6, 'interop', 'uhf tactical', 'nfm', 156.7),
    ch('utac43', 'UTAC43', 453.8625e6, 'interop', 'uhf tactical', 'nfm', 156.7),
    ch('8call90', '8CALL90', 851.0125e6, 'interop', '800 mhz calling'),
    ch('8tac91', '8TAC91', 851.5125e6, 'interop', '800 mhz tactical'),
    ch('8tac92', '8TAC92', 852.0125e6, 'interop', '800 mhz tactical'),
    ch('8tac93', '8TAC93', 852.5125e6, 'interop', '800 mhz tactical'),
    ch('8tac94', '8TAC94', 853.0125e6, 'interop', '800 mhz tactical'),
  ],
}

/** NOAA weather radio. Always on, and the easiest way to prove a receiver works. */
export const WEATHER: ChannelGroup = {
  id: 'weather',
  name: 'noaa weather',
  blurb: 'always transmitting, so it is the quickest way to check your antenna and gain',
  service: 'weather',
  channels: [
    ch('wx1', 'WX1', 162.55e6, 'weather', 'the most common one', 'nfm'),
    ch('wx2', 'WX2', 162.4e6, 'weather', undefined, 'nfm'),
    ch('wx3', 'WX3', 162.475e6, 'weather', undefined, 'nfm'),
    ch('wx4', 'WX4', 162.425e6, 'weather', undefined, 'nfm'),
    ch('wx5', 'WX5', 162.45e6, 'weather', undefined, 'nfm'),
    ch('wx6', 'WX6', 162.5e6, 'weather', undefined, 'nfm'),
    ch('wx7', 'WX7', 162.525e6, 'weather', undefined, 'nfm'),
  ],
}

export const AVIATION: ChannelGroup = {
  id: 'aviation',
  name: 'aviation',
  blurb: 'air band is amplitude modulated, so switch the demodulator to am or it sounds like nothing',
  service: 'aviation',
  channels: [
    ch('guard', 'guard', 121.5e6, 'aviation', 'the civil emergency channel, usually silent', 'am'),
    ch('unicom', 'unicom', 122.8e6, 'aviation', 'uncontrolled field traffic', 'am'),
    ch('unicom123', 'unicom 123.0', 123.0e6, 'aviation', 'uncontrolled field traffic', 'am'),
    ch('atis', 'common atis', 135.4e6, 'aviation', 'recorded field conditions, varies by airport', 'am'),
  ],
}

export const MARINE: ChannelGroup = {
  id: 'marine',
  name: 'marine vhf',
  blurb: 'coastal and lake traffic',
  service: 'marine',
  channels: [
    ch('m16', 'channel 16', 156.8e6, 'marine', 'distress and calling, monitored everywhere'),
    ch('m9', 'channel 9', 156.45e6, 'marine', 'boater calling'),
    ch('m13', 'channel 13', 156.65e6, 'marine', 'bridge to bridge navigation'),
    ch('m22a', 'channel 22A', 157.1e6, 'marine', 'coast guard liaison and broadcasts'),
  ],
}

export const UNLICENSED: ChannelGroup = {
  id: 'unlicensed',
  name: 'licence free',
  blurb: 'murs, frs, and gmrs, where neighbours, event crews, and shops talk',
  service: 'unlicensed',
  channels: [
    ch('murs1', 'MURS 1', 151.82e6, 'unlicensed'),
    ch('murs2', 'MURS 2', 151.88e6, 'unlicensed'),
    ch('murs3', 'MURS 3', 151.94e6, 'unlicensed'),
    ch('murs4', 'MURS 4', 154.57e6, 'unlicensed', 'the blue dot business channel'),
    ch('murs5', 'MURS 5', 154.6e6, 'unlicensed', 'the green dot business channel'),
    ch('frs1', 'FRS 1', 462.5625e6, 'unlicensed'),
    ch('frs2', 'FRS 2', 462.5875e6, 'unlicensed'),
    ch('frs3', 'FRS 3', 462.6125e6, 'unlicensed'),
    ch('frs4', 'FRS 4', 462.6375e6, 'unlicensed'),
    ch('frs5', 'FRS 5', 462.6625e6, 'unlicensed'),
    ch('frs6', 'FRS 6', 462.6875e6, 'unlicensed'),
    ch('frs7', 'FRS 7', 462.7125e6, 'unlicensed'),
    ch('gmrs15', 'GMRS 15', 462.55e6, 'unlicensed'),
    ch('gmrs16', 'GMRS 16', 462.575e6, 'unlicensed'),
    ch('gmrs17', 'GMRS 17', 462.6e6, 'unlicensed'),
    ch('gmrs18', 'GMRS 18', 462.625e6, 'unlicensed'),
    ch('gmrs19', 'GMRS 19', 462.65e6, 'unlicensed'),
    ch('gmrs20', 'GMRS 20', 462.675e6, 'unlicensed', 'the travel and emergency channel'),
    ch('gmrs21', 'GMRS 21', 462.7e6, 'unlicensed'),
    ch('gmrs22', 'GMRS 22', 462.725e6, 'unlicensed'),
  ],
}

export const HAM: ChannelGroup = {
  id: 'ham',
  name: 'ham calling',
  blurb: 'the simplex calling frequencies, where operators find each other',
  service: 'ham',
  channels: [
    ch('ham6m', '6 m calling', 52.525e6, 'ham'),
    ch('ham2m', '2 m calling', 146.52e6, 'ham', 'the busiest simplex channel in the country'),
    ch('ham125', '1.25 m calling', 223.5e6, 'ham'),
    ch('ham70cm', '70 cm calling', 446.0e6, 'ham'),
  ],
}

/**
 * Railroad channels moved to a 7.5 kHz grid in the narrowbanding change, so
 * these are the AAR channel centres rather than the older 15 kHz spacing.
 */
export const RAILROAD: ChannelGroup = {
  id: 'railroad',
  name: 'railroad',
  blurb: 'road, yard, and dispatch traffic on the aar channel grid',
  service: 'railroad',
  channels: Array.from({ length: 20 }, (_, i) =>
    ch(
      `aar${String(i + 20).padStart(3, '0')}`,
      `AAR ${i + 20}`,
      160.215e6 + i * 15e3,
      'railroad',
      i === 0 ? 'the low end of the band, scan the whole group to find the local road channel' : undefined,
    ),
  ),
}

export const CHANNEL_GROUPS: ChannelGroup[] = [
  INTEROP,
  WEATHER,
  AVIATION,
  MARINE,
  UNLICENSED,
  HAM,
  RAILROAD,
]

export function allConventional(): ConventionalChannel[] {
  return CHANNEL_GROUPS.flatMap((g) => g.channels)
}

export function channelById(id: string): ConventionalChannel | undefined {
  return allConventional().find((c) => c.id === id)
}

export const SERVICE_LABELS: Record<ServiceTag, string> = {
  interop: 'interop',
  fire: 'fire',
  law: 'law',
  ems: 'ems',
  weather: 'weather',
  marine: 'marine',
  aviation: 'aviation',
  railroad: 'railroad',
  ham: 'ham',
  unlicensed: 'licence free',
  other: 'other',
}

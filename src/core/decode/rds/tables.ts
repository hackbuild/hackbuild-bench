/**
 * Lookup tables: programme types, the RDS character set, and the RBDS rule
 * that turns a PI code back into a US call sign.
 */

/** NRSC-4-B programme type names, as North American receivers show them. */
export const PTY_RBDS: readonly string[] = [
  'none', 'news', 'information', 'sports', 'talk', 'rock', 'classic rock', 'adult hits',
  'soft rock', 'top 40', 'country', 'oldies', 'soft', 'nostalgia', 'jazz', 'classical',
  'rhythm and blues', 'soft rhythm and blues', 'language', 'religious music', 'religious talk',
  'personality', 'public', 'college', 'spanish talk', 'spanish music', 'hip hop', 'unassigned',
  'unassigned', 'weather', 'emergency test', 'emergency',
]

/** IEC 62106 programme type names, for the rest of the world. */
export const PTY_RDS: readonly string[] = [
  'none', 'news', 'current affairs', 'information', 'sport', 'education', 'drama', 'culture',
  'science', 'varied', 'pop music', 'rock music', 'easy listening', 'light classical',
  'serious classical', 'other music', 'weather', 'finance', "children's programmes",
  'social affairs', 'religion', 'phone in', 'travel', 'leisure', 'jazz music', 'country music',
  'national music', 'oldies music', 'folk music', 'documentary', 'alarm test', 'alarm',
]

/** EN 50067 annex E, code table G0, as unicode. Control codes read as spaces. */
const G0_HIGH =
  'áàéèíìóòúùÑÇŞβ¡Ĳâäêëîïôöûüñçşǧıĳªα©‰Ǧěňőπ€£$←↑→↓º¹²³±İńűµ¿÷°¼½¾§' +
  'ÁÀÉÈÍÌÓÒÚÙŘČŠŽÐĿÂÄÊËÎÏÔÖÛÜřčšžđŀÃÅÆŒŷÝÕØÞŊŔĆŚŹŦðãåæœŵýõøþŋŕćśźŧ '

export function rdsChar(code: number): string {
  if (code >= 0x80) return G0_HIGH[code - 0x80] ?? ' '
  if (code < 0x20 || code === 0x7f) return ' '
  switch (code) {
    case 0x24:
      return '¤'
    case 0x5e:
      return '―'
    case 0x60:
      return '‖'
    case 0x7e:
      return '¯'
    default:
      return String.fromCharCode(code)
  }
}

/** NRSC-4-B D.7: the three letter call signs, which have their own codes. */
const THREE_LETTER: Record<number, string> = {
  0x99a5: 'KBW', 0x9992: 'KOY', 0x9978: 'WHO', 0x99a6: 'KCY', 0x9993: 'KPQ', 0x999c: 'WHP',
  0x9990: 'KDB', 0x9964: 'KQV', 0x999d: 'WIL', 0x99a7: 'KDF', 0x9994: 'KSD', 0x997a: 'WIP',
  0x9950: 'KEX', 0x9965: 'KSL', 0x99b3: 'WIS', 0x9951: 'KFH', 0x9966: 'KUJ', 0x997b: 'WJR',
  0x9952: 'KFI', 0x9995: 'KUT', 0x99b4: 'WJW', 0x9953: 'KGA', 0x9967: 'KVI', 0x99b5: 'WJZ',
  0x9991: 'KGB', 0x9968: 'KWG', 0x997c: 'WKY', 0x9954: 'KGO', 0x9996: 'KXL', 0x997d: 'WLS',
  0x9955: 'KGU', 0x9997: 'KXO', 0x997e: 'WLW', 0x9956: 'KGW', 0x996b: 'KYW', 0x999e: 'WMC',
  0x9957: 'KGY', 0x9999: 'WBT', 0x999f: 'WMT', 0x99aa: 'KHQ', 0x996d: 'WBZ', 0x9981: 'WOC',
  0x9958: 'KID', 0x996e: 'WDZ', 0x99a0: 'WOI', 0x9959: 'KIT', 0x996f: 'WEW', 0x9983: 'WOL',
  0x995a: 'KJR', 0x999a: 'WGH', 0x9984: 'WOR', 0x995b: 'KLO', 0x9971: 'WGL', 0x99a1: 'WOW',
  0x995c: 'KLZ', 0x9972: 'WGN', 0x99b9: 'WRC', 0x995d: 'KMA', 0x9973: 'WGR', 0x99a2: 'WRR',
  0x995e: 'KMJ', 0x999b: 'WGY', 0x99a3: 'WSB', 0x995f: 'KNX', 0x9975: 'WHA', 0x99a4: 'WSM',
  0x9960: 'KOA', 0x9976: 'WHB', 0x9988: 'WWJ', 0x99ab: 'KOB', 0x9977: 'WHK', 0x9989: 'WWL',
}

/** Nationally linked networks, which carry a network code instead of a call sign. */
const LINKED: Record<number, string> = {
  0xb001: 'npr-1', 0xb002: 'cbc radio one', 0xb003: 'cbc radio two',
  0xb004: 'radio-canada premiere', 0xb005: 'radio-canada espace musique',
  0xb006: 'cbc', 0xb007: 'cbc', 0xb008: 'cbc', 0xb009: 'cbc', 0xb00a: 'npr-2',
  0xb00b: 'npr-3', 0xb00c: 'npr-4', 0xb00d: 'npr-5', 0xb00e: 'npr-6',
}

export interface CallSign {
  call: string
  /**
   * PI codes from 0x1000 are also handed to stations whose call sign does
   * not map, so a K call from that first block may be a coincidence.
   */
  uncertain: boolean
}

/** NRSC-4-B D.7, the PI code back to the call sign it was derived from. */
export function callSignFromPi(piIn: number): CallSign | null {
  let pi = piIn & 0xffff
  const uncertain = (pi & 0xf000) === 0x1000
  // codes with a zero nibble are moved into the A block, which undoes here.
  if ((pi & 0xfff0) === 0xafa0 && (pi & 0xf) < 0xa) pi = (pi << 12) & 0xffff
  else if ((pi & 0xff00) === 0xaf00) pi = (pi << 8) & 0xffff
  else if ((pi & 0xf000) === 0xa000) pi = ((pi & 0x0f00) << 4) | (pi & 0x00ff)

  if (pi >= 0x9950 && pi <= 0x9eff) {
    const c = THREE_LETTER[pi]
    return c ? { call: c, uncertain: false } : null
  }
  const nibble = pi >> 12
  if (nibble === 0xb || nibble === 0xd || nibble === 0xe) {
    const c = LINKED[pi & 0xf0ff]
    return c ? { call: c, uncertain: false } : null
  }
  if (pi >= 0x1000 && pi <= 0x994f) {
    const w = pi > 0x54a7
    let n = pi - (w ? 0x54a8 : 0x1000)
    const c3 = n % 26
    n = Math.floor(n / 26)
    const c2 = n % 26
    const c1 = Math.floor(n / 26) % 26
    const L = (k: number) => String.fromCharCode(65 + k)
    return { call: (w ? 'W' : 'K') + L(c1) + L(c2) + L(c3), uncertain }
  }
  return null
}

/** Method A alternative frequency code to Hz, VHF band only. */
export function afToHz(code: number): number | null {
  if (code >= 1 && code <= 204) return 87_500_000 + code * 100_000
  return null
}

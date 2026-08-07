/**
 * BLE link layer and advertisement decoding.
 *
 * Input is a link layer frame starting at the access address, which is the
 * shape both the Ubertooth usb_pkt_rx payload and an nRF sniffer report carry,
 * so both radios share this decoder.
 */

/** Advertising access address, Core spec vol 6 part B section 2.1.2. */
export const ADV_ACCESS_ADDRESS = 0x8e89bed6

const PDU_ADV = [
  'ADV_IND',
  'ADV_DIRECT_IND',
  'ADV_NONCONN_IND',
  'SCAN_REQ',
  'SCAN_RSP',
  'CONNECT_IND',
  'ADV_SCAN_IND',
  'ADV_EXT_IND',
  'AUX_CONNECT_RSP',
]

const AD_TYPES: Record<number, string> = {
  0x01: 'Flags',
  0x02: 'UUID16',
  0x03: 'UUID16',
  0x04: 'UUID32',
  0x05: 'UUID32',
  0x06: 'UUID128',
  0x07: 'UUID128',
  0x08: 'ShortName',
  0x09: 'Name',
  0x0a: 'TxPower',
  0x12: 'ConnInterval',
  0x16: 'SvcData',
  0x19: 'Appearance',
  0x1b: 'PubAddr',
  0xff: 'MfrData',
}

const COMPANIES: Record<number, string> = {
  0x0001: 'Ericsson',
  0x0006: 'Microsoft',
  0x000f: 'Broadcom',
  0x004c: 'Apple',
  0x004f: 'Logitech',
  0x0059: 'Nordic',
  0x0075: 'Samsung',
  0x0087: 'Garmin',
  0x00d2: 'Nordic',
  0x00e0: 'Google',
  0x0118: 'Tile',
  0x0131: 'Cypress',
  0x0157: 'Xiaomi',
  0x02e5: 'Espressif',
  0x038f: 'Xiaomi',
  0x0499: 'Ruuvi',
}

export interface AdStructure {
  /** AD type byte. */
  type: number
  /** Short name for the type, or the hex type when unknown. */
  name: string
  bytes: Uint8Array
  /** Printable rendering: text for names, hex for everything else. */
  text: string
  company?: string
}

export interface ManufacturerData {
  id: number
  company: string
  bytes: Uint8Array
}

export interface Advertisement {
  accessAddress: number
  /** False for a data channel PDU, where the access address is a connection's. */
  isAdvertising: boolean
  pduType: string
  /** Raw low nibble of header byte 0. */
  pduRaw: number
  txAdd: number
  rxAdd: number
  /** Payload length from header byte 1. */
  length: number
  /** Link layer bytes actually covered by the header length. */
  frame: Uint8Array
  advertiser?: string
  ads: AdStructure[]
  name?: string
  flags?: number
  serviceUuids: string[]
  manufacturer?: ManufacturerData
  /** Set for data channel PDUs. */
  llid?: number
  payload?: Uint8Array
  summary: string
}

export function hex(bytes: Uint8Array, sep = ''): string {
  const out: string[] = []
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i].toString(16).padStart(2, '0'))
  return out.join(sep)
}

/** Six address bytes arrive least significant first. */
export function macFromLe(bytes: Uint8Array): string {
  const out: string[] = []
  for (let i = bytes.length - 1; i >= 0; i--) out.push(bytes[i].toString(16).padStart(2, '0'))
  return out.join(':')
}

/** 2402, 2426 and 2480 MHz are the advertising channels. Returns -1 off plan. */
export function freqToBleChannel(mhz: number): number {
  if (mhz === 2402) return 37
  if (mhz === 2426) return 38
  if (mhz === 2480) return 39
  if (mhz >= 2404 && mhz <= 2424 && mhz % 2 === 0) return (mhz - 2404) / 2
  if (mhz >= 2428 && mhz <= 2478 && mhz % 2 === 0) return (mhz - 2428) / 2 + 11
  return -1
}

function uuid16List(v: Uint8Array): string[] {
  const out: string[] = []
  for (let i = 0; i + 1 < v.length; i += 2) {
    out.push((((v[i + 1] << 8) | v[i]) >>> 0).toString(16).padStart(4, '0'))
  }
  return out
}

function uuid32List(v: Uint8Array): string[] {
  const out: string[] = []
  for (let i = 0; i + 3 < v.length; i += 4) {
    const u = ((v[i + 3] << 24) | (v[i + 2] << 16) | (v[i + 1] << 8) | v[i]) >>> 0
    out.push(u.toString(16).padStart(8, '0'))
  }
  return out
}

function uuid128List(v: Uint8Array): string[] {
  const out: string[] = []
  for (let i = 0; i + 15 < v.length; i += 16) {
    const s = hex(v.subarray(i, i + 16).slice().reverse())
    out.push(
      `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`,
    )
  }
  return out
}

/**
 * Walk the length prefixed AD structures of an advertising payload. A zero
 * length or a length running past the buffer ends the walk, since a truncated
 * capture is normal.
 */
export function parseAdStructures(pl: Uint8Array): AdStructure[] {
  const out: AdStructure[] = []
  let i = 0
  while (i < pl.length) {
    const len = pl[i]
    if (len === 0 || i + 1 + len > pl.length) break
    const type = pl[i + 1]
    const val = pl.subarray(i + 2, i + 1 + len)
    const entry: AdStructure = {
      type,
      name: AD_TYPES[type] ?? `0x${type.toString(16).padStart(2, '0')}`,
      bytes: val.slice(),
      text: hex(val),
    }
    if (type === 0x08 || type === 0x09) {
      entry.text = new TextDecoder().decode(val)
    } else if (type === 0x0a && val.length >= 1) {
      entry.text = `${(val[0] << 24) >> 24} dBm`
    } else if (type === 0xff && val.length >= 2) {
      const cid = val[0] | (val[1] << 8)
      entry.company = COMPANIES[cid] ?? `0x${cid.toString(16).padStart(4, '0')}`
      entry.text = entry.company
    } else if (type === 0x01) {
      entry.text = `0x${hex(val)}`
    }
    out.push(entry)
    i += 1 + len
  }
  return out
}

/**
 * `bytes` starts at the access address: 4 bytes AA, 2 bytes header, payload.
 * Returns null when the frame is too short to carry a header.
 */
export function parseAdvertisement(bytes: Uint8Array): Advertisement | null {
  if (bytes.length < 6) return null
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const accessAddress = dv.getUint32(0, true) >>> 0
  const h0 = bytes[4]
  const h1 = bytes[5]
  const length = h1 & 0x3f
  const isAdvertising = accessAddress === ADV_ACCESS_ADDRESS
  const pduRaw = h0 & 0x0f
  const end = Math.min(6 + length, bytes.length)

  const adv: Advertisement = {
    accessAddress,
    isAdvertising,
    pduType: isAdvertising ? (PDU_ADV[pduRaw] ?? `ADV_${pduRaw}`) : 'DATA',
    pduRaw,
    txAdd: (h0 >> 6) & 1,
    rxAdd: (h0 >> 7) & 1,
    length,
    frame: bytes.subarray(0, end).slice(),
    ads: [],
    serviceUuids: [],
    summary: '',
  }

  if (!isAdvertising) {
    adv.llid = h0 & 0x03
    adv.payload = bytes.subarray(6, end).slice()
    adv.summary = `DATA  llid ${adv.llid}  ${length} bytes`
    return adv
  }

  const pl = bytes.subarray(6, end)
  // SCAN_REQ and CONNECT_IND carry the initiator address first, then AdvA.
  // Every other advertising PDU opens with AdvA and its AD structures.
  if (pduRaw === 3 || pduRaw === 5) {
    if (pl.length >= 12) adv.advertiser = macFromLe(pl.subarray(6, 12))
  } else if (pl.length >= 6) {
    adv.advertiser = macFromLe(pl.subarray(0, 6))
    adv.ads = parseAdStructures(pl.subarray(6))
  }

  for (const ad of adv.ads) {
    if (ad.type === 0x01 && ad.bytes.length >= 1) adv.flags = ad.bytes[0]
    else if (ad.type === 0x09 || (ad.type === 0x08 && adv.name === undefined)) adv.name = ad.text
    else if (ad.type === 0x02 || ad.type === 0x03) adv.serviceUuids.push(...uuid16List(ad.bytes))
    else if (ad.type === 0x04 || ad.type === 0x05) adv.serviceUuids.push(...uuid32List(ad.bytes))
    else if (ad.type === 0x06 || ad.type === 0x07) adv.serviceUuids.push(...uuid128List(ad.bytes))
    else if (ad.type === 0xff && ad.bytes.length >= 2) {
      const id = ad.bytes[0] | (ad.bytes[1] << 8)
      adv.manufacturer = {
        id,
        company: ad.company ?? `0x${id.toString(16).padStart(4, '0')}`,
        bytes: ad.bytes.subarray(2).slice(),
      }
    }
  }

  const tail = adv.name ?? adv.manufacturer?.company ?? adv.advertiser ?? ''
  adv.summary = tail ? `${adv.pduType}  ${tail}` : adv.pduType
  return adv
}

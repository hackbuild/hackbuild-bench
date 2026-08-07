import type { Capability } from '../../capabilities'
import { CAPABILITIES } from '../../capabilities'
import type { DeviceDescriptor, TransportKind } from '../../types'
import type { DeviceDriver, DeviceHandle, DeviceSession, DriverContext } from '../types'
import { HttpEndpoint } from '../../transport/http'

/**
 * WiFi Pineapple over its REST API, called straight from the browser. There is
 * no bridge and no companion app. The page must be served over http so the
 * browser will let it reach the appliance over http, otherwise the transport
 * raises MixedContentError and the message says what to do.
 *
 * Access cannot come from a browser picker the way usb and serial do, so the
 * connect UI collects the base url and credentials, calls setPendingAccess with
 * them, then triggers the normal requestAccess flow. requestAccess reads and
 * clears that pending value and builds the handle from it.
 */

const DEFAULT_BASE = 'http://172.16.42.1:1471'
const POLL_MS = 3000

// the mark vii firmware has changed its api shape across releases, so these
// paths are a starting point rather than a guarantee. the survey panel shows
// the raw response so a mismatch is visible, and the paths are read from the
// access fields where a firmware differs.
const PATH_LOGIN = '/api/login'
const PATH_INFO = '/api/system/info'
const PATH_SCAN = '/api/recon/scan'
const PATH_APS = '/api/recon/aps'
const PATH_CLIENTS = '/api/recon/clients'
const PATH_PINEAP = '/api/pineap/settings'
const PATH_DEAUTH = '/api/recon/deauth'

export interface PineappleAccess {
  base: string
  username: string
  password: string
}

let pendingAccess: PineappleAccess | null = null

/** The connect UI calls this with the values it collected before requestAccess. */
export function setPendingAccess(access: PineappleAccess): void {
  pendingAccess = access
}

interface LoginResponse {
  token?: string
  success?: boolean
  error?: string
}

interface ApRow {
  ssid?: string
  bssid?: string
  mac?: string
  channel?: number
  encryption?: string
  security?: string
  rssi?: number
  signal?: number
}

const descriptor: DeviceDescriptor = {
  kind: 'pineapple',
  name: 'WiFi Pineapple',
  blurb: 'recon on the network you run, over its rest api',
  icon: 'wifi',
  transports: ['http'],
  capabilities: [CAPABILITIES.NET_SURVEY, CAPABILITIES.NET_ATTACK],
  params: [],
  accessFields: [
    {
      key: 'base',
      label: 'address',
      type: 'url',
      default: DEFAULT_BASE,
      placeholder: DEFAULT_BASE,
    },
    { key: 'username', label: 'username', type: 'text', default: 'root' },
    { key: 'password', label: 'password', type: 'password', default: '' },
  ],
  limits: {
    [CAPABILITIES.NET_SURVEY]:
      'this is the one device the browser cannot reach on its own. two walls: the pineapple serves plain http so an https page is blocked as mixed content, and stock mark vii firmware sends no cross origin headers, so even from http on localhost the browser refuses the response. it works only against a pineapple whose firmware is set to allow this origin. everything else on the bench needs no such change.',
  },
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true },
    )
  })

function normalizeRows(data: unknown): ApRow[] {
  if (Array.isArray(data)) return data as ApRow[]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    for (const key of ['aps', 'clients', 'results', 'data']) {
      if (Array.isArray(obj[key])) return obj[key] as ApRow[]
    }
  }
  return []
}

class PineappleSession implements DeviceSession {
  private stopped = false
  private scanStarted = false

  constructor(
    private endpoint: HttpEndpoint,
    private base: string,
    private ctx: DriverContext,
  ) {
    ctx.signal.addEventListener('abort', () => {
      this.stopped = true
    })
  }

  getCapabilities(): Capability[] {
    return [CAPABILITIES.NET_SURVEY, CAPABILITIES.NET_ATTACK]
  }

  getInfo(): Record<string, string> {
    return { base: this.base, transport: 'http' }
  }

  async configure(): Promise<void> {
    // no runtime parameters.
  }

  async start(mode: string): Promise<void> {
    if (mode !== 'survey') throw new Error(`pineapple has no ${mode} mode`)
    this.stopped = false
    void this.surveyLoop()
    this.ctx.log('surveying nearby wifi')
  }

  async stop(): Promise<void> {
    this.stopped = true
  }

  async resetToSafeState(): Promise<void> {
    this.stopped = true
  }

  async close(): Promise<void> {
    this.stopped = true
  }

  async health(): Promise<boolean> {
    try {
      await this.endpoint.get(PATH_INFO)
      return true
    } catch {
      return false
    }
  }

  /** Turn PineAP on or off. Acts on nearby clients, so it needs wifi active armed. */
  async setPineAp(enabled: boolean): Promise<void> {
    if (!this.ctx.isArmed(CAPABILITIES.NET_ATTACK)) {
      throw new Error('wifi active is not armed. arm wifi active to change pineap.')
    }
    await this.endpoint.post(PATH_PINEAP, { enabled })
    this.ctx.log(`pineap ${enabled ? 'on' : 'off'}`)
  }

  /** Deauthenticate a client. Acts on a client, so it needs wifi active armed. */
  async deauthClient(mac: string): Promise<void> {
    if (!this.ctx.isArmed(CAPABILITIES.NET_ATTACK)) {
      throw new Error('wifi active is not armed. arm wifi active to act on clients.')
    }
    await this.endpoint.post(PATH_DEAUTH, { mac })
    this.ctx.log(`deauth ${mac}`)
  }

  private async surveyLoop(): Promise<void> {
    while (!this.stopped && !this.ctx.signal.aborted) {
      try {
        await this.pollOnce()
      } catch (err) {
        this.ctx.log(err instanceof Error ? err.message : String(err))
      }
      await sleep(POLL_MS, this.ctx.signal)
    }
  }

  private async pollOnce(): Promise<void> {
    // the mark vii recon module is scan based: start a scan, then read the
    // results it accumulated. we start one on the first pass and let later
    // passes read what it has found so far.
    if (!this.scanStarted) {
      try {
        await this.endpoint.post(PATH_SCAN, { scan_time: 30, continuous: true })
        this.scanStarted = true
      } catch {
        // some firmwares scan continuously with no start call, so fall through
        // to reading results rather than giving up.
        this.scanStarted = true
      }
    }
    const apData = await this.endpoint.get<unknown>(PATH_APS)
    for (const row of normalizeRows(apData)) this.emitRow(row)
    const clientData = await this.endpoint.get<unknown>(PATH_CLIENTS)
    for (const row of normalizeRows(clientData)) this.emitRow(row)
  }

  private emitRow(row: ApRow): void {
    const ssid = row.ssid ?? ''
    const bssid = row.bssid ?? row.mac ?? ''
    const channel = row.channel
    const encryption = row.encryption ?? row.security ?? ''
    const rssi = row.rssi ?? row.signal
    const rec = {
      kind: 'packet' as const,
      bytes: new Uint8Array(0),
      proto: '802.11',
      channel,
      rssi,
      fields: { ssid, bssid, channel, encryption, rssi },
      summary: `${ssid || '(hidden)'} ${bssid} ch${channel ?? '?'} ${rssi ?? '?'}dBm ${encryption}`.trim(),
    }
    this.ctx.emit(rec)
  }
}

export const pineappleDriver: DeviceDriver = {
  descriptor,

  availableTransports(): TransportKind[] {
    return ['http']
  },

  async requestAccess(
    transport: TransportKind,
    fields?: Record<string, string>,
  ): Promise<DeviceHandle | null> {
    if (transport !== 'http') return null

    // the connect dialog collects the descriptor's accessFields and passes
    // them here. setPendingAccess stays as the path for callers that are not
    // the dialog, such as a playbook reconnecting a known appliance.
    const access: PineappleAccess = {
      base: fields?.base?.trim() || pendingAccess?.base || DEFAULT_BASE,
      username: fields?.username ?? pendingAccess?.username ?? '',
      password: fields?.password ?? pendingAccess?.password ?? '',
    }
    pendingAccess = null

    if (!access.username) {
      throw new Error('the pineapple needs a username and password, the defaults are on its label')
    }

    return {
      kind: 'pineapple',
      transport: 'http',
      uid: `pineapple-${access.base}`,
      label: 'WiFi Pineapple',
      raw: access,
    }
  },

  async open(handle: DeviceHandle, ctx: DriverContext): Promise<DeviceSession> {
    const access = handle.raw as PineappleAccess
    const base = access.base || DEFAULT_BASE
    const endpoint = new HttpEndpoint({ base })

    const login = await endpoint.post<LoginResponse>(PATH_LOGIN, {
      username: access.username,
      password: access.password,
    })
    if (!login?.token) {
      throw new Error(login?.error ?? 'login failed, check the username and password')
    }
    endpoint.setToken(login.token)

    const info = await endpoint.get<Record<string, unknown>>(PATH_INFO)
    const flat: Record<string, string> = { base, transport: 'http' }
    if (info && typeof info === 'object') {
      for (const [k, v] of Object.entries(info)) {
        if (typeof v === 'string' || typeof v === 'number') flat[k] = String(v)
      }
    }
    ctx.setInfo(flat)

    return new PineappleSession(endpoint, base, ctx)
  },
}

export type { PineappleSession }

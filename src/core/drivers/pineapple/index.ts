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

const PATH_LOGIN = '/api/login'
const PATH_INFO = '/api/system/info'
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
  blurb: 'recon on the network you run',
  icon: 'wifi',
  transports: ['http'],
  capabilities: [CAPABILITIES.NET_SURVEY, CAPABILITIES.NET_ATTACK],
  params: [],
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

  async requestAccess(transport: TransportKind): Promise<DeviceHandle | null> {
    if (transport !== 'http') return null
    const access = pendingAccess ?? { base: DEFAULT_BASE, username: '', password: '' }
    pendingAccess = null
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

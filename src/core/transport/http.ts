/**
 * HTTP transport for network appliances that expose a REST API on the local
 * network, the WiFi Pineapple being the one we care about.
 *
 * There is no bridge. The browser talks to the appliance directly, which works
 * when the page is served over http on localhost and the appliance is on the
 * same network. From an https page the request is blocked as mixed content,
 * and the UI says so rather than failing silently.
 */

export interface HttpEndpointOptions {
  base: string
  token?: string
  timeoutMs?: number
}

export class MixedContentError extends Error {
  constructor(base: string) {
    super(
      `this page is served over https and cannot call ${base} over http. serve the bench over http on localhost, or open the appliance ui directly.`,
    )
    this.name = 'MixedContentError'
  }
}

export class HttpEndpoint {
  private base: string
  private token: string | undefined
  private timeoutMs: number

  constructor(opts: HttpEndpointOptions) {
    this.base = opts.base.replace(/\/$/, '')
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs ?? 8000
  }

  setToken(token: string): void {
    this.token = token
  }

  get blockedByMixedContent(): boolean {
    return (
      typeof location !== 'undefined' &&
      location.protocol === 'https:' &&
      this.base.startsWith('http://')
    )
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (this.blockedByMixedContent) throw new MixedContentError(this.base)

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.base}${path}`, {
        ...init,
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(init?.headers ?? {}),
        },
      })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const text = await res.text()
      return (text ? JSON.parse(text) : null) as T
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`no response from ${this.base} within ${this.timeoutMs} ms`)
      }
      if (err instanceof TypeError) {
        throw new Error(
          `cannot reach ${this.base}. check the appliance is powered, you are on its network, and it allows cross origin requests.`,
        )
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' })
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) })
  }
}

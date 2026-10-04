import { networkInterfaces } from 'node:os'
import { hostService } from './services.js'
/**
 * The plugin's HTTP surface: the route allowlist, the loopback/trust fence, the body
 * reader and the JSON envelopes the client expects. No tool logic lives here.
 */
/** HTTP API prefix (must match client.js; globally unique). */
export const API_PREFIX = '/dsh-hmos-emulator/api'
/** Allowed API methods (keeps this from becoming an arbitrary command executor). */
export const METHODS = new Set([
  'toolchain', 'emu.list', 'emu.start', 'emu.stop',
  'devices', 'scan', 'project.info', 'check.lint', 'lint.notify', 'deploy', 'device.ready', 'deveco.install', 'deveco.update', 'screenshot',
])
/** Methods whose handler owns the response (streaming); they skip the JSON envelope. */
export const STREAMING_METHODS = new Set(['deploy'])
/** Body cap for one request: the panel only ever sends a small JSON payload. */
export const MAX_BODY_BYTES = 1_000_000

export function headerValue(headers: any, name: string): string | undefined {
  const value = headers?.[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host/trustedHosts authority, or undefined when unparsable. */
export function parseAuthority(authority: string | undefined): URL | undefined {
  if (authority === undefined || authority === '') return undefined
  try {
    // http: is a WHATWG "special scheme": parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** localhost, IPv6 loopback, or any 127/8 IPv4 address (DSH's loopback-hostname.ts). */
export function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether one request may reach this plugin's API — the browser-trust fence DSH applies to its
 * own /api (packages/client/connection/src/api-request-trust.ts). This route is registered as a
 * prefix on webServer, so it inherits none of DSH's fencing; without it a DNS-rebound host or a
 * malicious page could drive deveco.install, check.lint --fix or deploy on the host.
 *  - Host binds every request: a browser fills Host from the URL it believes it is talking to,
 *    so a rebound page carries the attacker's domain even though the socket lands here.
 *  - `sec-fetch-site: cross-site` is refused outright, whatever the Origin says.
 *  - An attached Origin must be this exact authority; "null" (opaque origin) is refused.
 * @param req - the node request.
 * @param trustedHosts - non-loopback authorities this deployment also serves, in DSH's
 *   client-connection shape: a port-less entry matches that host on any port.
 */
export function isTrustedRequest(req: any, trustedHosts: readonly string[] = []): boolean {
  const hostUrl = parseAuthority(headerValue(req?.headers, 'host'))
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname)) {
    const declared = trustedHosts.some((entry) => {
      const entryUrl = parseAuthority(entry)
      if (entryUrl === undefined) return false
      return entryUrl.port === '' ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host
    })
    if (!declared) return false
  }
  if (headerValue(req?.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = headerValue(req?.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Fence authorities for this deployment, taken from the same source DSH's own /api uses: the Web
 * runtime publishes `{ lanAddresses, trustedHosts }` as the `webRuntime` service, already folding
 * in `dsh web --trusted-host` and this machine's LAN literals (resolveLanTrust). Reading it keeps
 * the two fences in step — a second, plugin-private trust list is how a deployment ends up with a
 * panel that 403s while the rest of the GUI keeps working.
 * Loopback is always accepted by isTrustedRequest and needs no entry here. When the service is absent
 * (a non-web host context), fall back to deriving the LAN literals a `0.0.0.0` bind is reached by:
 * only IP literals, since DNS rebinding needs an attacker-controlled name and an IP-literal Host
 * is safe on any port.
 * @param webRuntime - the published `{ lanAddresses, trustedHosts }`, when present.
 * @param bindHost - the webserver's active bind host.
 */
export function fenceAuthorities(webRuntime: any, bindHost: unknown): string[] {
  const published = webRuntime?.trustedHosts
  if (Array.isArray(published)) {
    return published.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
  }
  if (bindHost !== '0.0.0.0') return []
  return Object.values(networkInterfaces()).flat()
    .filter((iface) => iface !== undefined && iface.family === 'IPv4' && !iface.internal)
    .map((iface) => String(iface?.address ?? ''))
    .filter((address) => address !== '')
}

export function readBody(req: any): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      // Running total, not a per-chunk sum: the old reduce was O(n²) on a large body.
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        chunks.length = 0
        // Reject so the handler can answer 413, and drain the rest so that answer is writable.
        rejectBody(Object.assign(new Error(`请求体过大(上限 ${MAX_BODY_BYTES} 字节)`), { code: 'too-large' }))
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolveBody(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      rejectBody(error)
    })
  })
}

export function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

export function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

export function writeError(res, error) {
  const code = error && error.code ? error.code : 'internal'
  const message = error instanceof Error ? error.message : String(error)
  // Every code a handler can raise as a caller-side precondition belongs in this 4xx set:
  // device-offline means "no online device to deploy to", which is the request's fault, not a
  // server fault, and a 500 would tell the caller to retry something that cannot succeed.
  const status = code === 'too-large' ? 413
    : code === 'bad-request' || code === 'toolchain' || code === 'fs-error' || code === 'image-missing' || code === 'device-offline' ? 400
      : 500
  writeJson(res, status, { ok: false, error: { code, message } })
}

/** What the request pipeline needs from the plugin that mounts it. */
export interface ApiRouteDeps {
  /** The method table `createApi()` returned: one handler per allowlisted method. */
  api: Record<string, (payload?: any, res?: any, ctl?: { signal?: AbortSignal }) => Promise<any>>
  /** The host context, read per request so the fence follows whatever DSH currently publishes. */
  ctx: { get(name: string): any }
  /** The webserver's bind host, used when the webRuntime service is absent. */
  host?: string
}

/**
 * The one pipeline behind API_PREFIX: POST-only, trust fence, JSON-only body, method allowlist, the
 * de-tagged payload, then the JSON envelope — or the streaming branch for a method that owns its
 * response. Registered as a prefix on webServer, so it inherits none of DSH's own /api fencing.
 */
export function createApiRoute({ api, ctx, host }: ApiRouteDeps) {
  return async (req: any, res: any) => {
    // The only cancel signal an HTTP route ever gets is the client going away, and it has to hang
    // off the response: a request's `close` fires as soon as its body is consumed. Without it a
    // 20-minute build keeps running after the panel tab is gone, holding the device.
    const abort = new AbortController()
    const onClose = () => { if (!res.writableEnded) abort.abort() }
    res.on?.('close', onClose)
    try {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method', message: 'only POST' } })
        return
      }
      // Fence first, before any method lookup: a rebound or cross-site caller must not
      // learn which methods exist, let alone reach install / lint --fix / deploy.
      // Read per request so the authorities stay whatever DSH currently publishes.
      if (!isTrustedRequest(req, fenceAuthorities(hostService(ctx, 'webRuntime'), host))) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: '请求来源不可信(Host/Origin 校验未通过)' } })
        return
      }
      // JSON-only: also refuses the no-preflight `text/plain` cross-site POST, which a
      // browser would otherwise deliver to this route without any CORS preflight.
      if (!/^application\/json\b/i.test(String(headerValue(req.headers, 'content-type') || ''))) {
        writeJson(res, 415, { ok: false, error: { code: 'media-type', message: 'content-type 必须是 application/json' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.slice(API_PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '')
      const handler = METHODS.has(method) ? api[method] : undefined
      if (handler === undefined) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method ${method}` } })
        return
      }
      let payload = {}
      const text = await readBody(req)
      if (text.trim()) {
        try {
          payload = JSON.parse(text)
        } catch {
          writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'body is not valid JSON' } })
          return
        }
      }
      // `origin` is not a wire field. It tags a screenshot as one the plugin itself took, and
      // only such a file is ever pruned — so a caller over HTTP must not be able to mint that
      // tag. The panel's shots keep `hmos-shot-*` and stay untouched forever (2026-09-19 rule).
      if (payload !== null && typeof payload === 'object') delete payload['origin']
      // Streaming methods own the response; errors depend on whether headers were sent.
      if (STREAMING_METHODS.has(method)) {
        try {
          await handler(payload, res, { signal: abort.signal })
        } catch (error) {
          if (!res.headersSent) writeError(res, error)
          else {
            try { res.write(`\n[HMOS_EXIT]=-2\n`) } catch { /* ignore */ }
            try { res.end() } catch { /* ignore */ }
          }
        }
        return
      }
      const value = await handler(payload, undefined, { signal: abort.signal })
      writeOk(res, value)
    } catch (error) {
      writeError(res, error)
    } finally {
      res.off?.('close', onClose)
    }
  }
}

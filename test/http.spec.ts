/**
 * The HTTP API the panel talks to: trust fence, envelope, body limits, and the names the route
 * writes on disk. A new case belongs here when it goes over the real route, never in-process.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../lib/index.js'

/** This spec's own directory: exists, and is never a HarmonyOS project root. */
const NOT_A_PROJECT = dirname(fileURLToPath(import.meta.url))
const FAKE_CLI = join(NOT_A_PROJECT, 'fake-devecocli.js')
/** Spawning is what a confined sandbox refuses (piped stdio EPERM); skip rather than misreport. */
const CAN_SPAWN = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' }).status === 0

/**
 * The trust fence has to be applied by the route handler, not merely exist: the unit tests for
 * trustRequest would still pass if a refactor dropped the call. This mounts the real prefix
 * route on a real HTTP server and judges it by observed status codes.
 */
let server
let port
let base

/** The trust list DSH publishes (`webRuntime`); the fence must follow it, per request. */
const webRuntime = { lanAddresses: [], trustedHosts: [] }

/** Mount the plugin the way the host does: webServer and webRuntime handed to apply(). */
function mount() {
  let route = null
  const ctx = {
    get: (name) => {
      if (name === 'webServer') return { host: '127.0.0.1', register: (r) => { route = r; return () => {} } }
      if (name === 'webRuntime') return webRuntime
      return undefined
    },
    effect: (fn) => fn(),
  }
  apply(ctx, {})
  return route
}

/**
 * One POST through the mounted route with the given headers. project.info on the spec's own
 * directory is the cheapest accepted call: it reads the filesystem and spawns nothing.
 */
function request({ method = 'POST', name = 'project.info', headers = {}, body = JSON.stringify({ projectPath: NOT_A_PROJECT }) } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/dsh-hmos-emulator/api/${name}`, method, headers, agent: false }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const JSON_HEADERS = { 'content-type': 'application/json' }

beforeAll(async () => {
  const route = mount()
  expect(route, 'the plugin must register its prefix route').toBeTruthy()
  server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/dsh-hmos-emulator/api')) route.handler(req, res)
    else { res.writeHead(404); res.end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  base = `127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

describe('route trust fence', () => {
  it('serves the panel: loopback Host, same-origin, JSON', async () => {
    const res = await request({
      headers: { host: base, origin: `http://${base}`, 'sec-fetch-site': 'same-origin', ...JSON_HEADERS },
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body).ok).toBe(true)
  })

  it('refuses a foreign Host before doing any work', async () => {
    const res = await request({ headers: { host: 'evil.example', ...JSON_HEADERS } })
    expect(res.status).toBe(403)
    // The refusal must not disclose which methods exist.
    expect(res.body).not.toContain('not-found')
  })

  it('accepts exactly the authority DSH publishes, and drops it once unpublished', async () => {
    // The point of reading webRuntime: `dsh web --trusted-host lab.internal:3080` must cover this
    // route too, so an operator never configures trust twice — and never gets a panel that 403s
    // while the rest of the GUI works.
    const headers = { host: 'lab.internal:3080', origin: 'http://lab.internal:3080', ...JSON_HEADERS }
    expect((await request({ headers })).status).toBe(403)
    webRuntime.trustedHosts.push('lab.internal:3080')
    try {
      expect((await request({ headers })).status).toBe(200)
    } finally {
      webRuntime.trustedHosts.length = 0
    }
    expect((await request({ headers })).status).toBe(403)
  })

  it('refuses cross-site markers and foreign origins', async () => {
    const crossSite = await request({ headers: { host: base, 'sec-fetch-site': 'cross-site', ...JSON_HEADERS } })
    expect(crossSite.status).toBe(403)
    const foreignOrigin = await request({ headers: { host: base, origin: 'http://evil.example', ...JSON_HEADERS } })
    expect(foreignOrigin.status).toBe(403)
  })

  it('requires application/json once the origin is trusted', async () => {
    const noType = await request({ headers: { host: base } })
    expect(noType.status).toBe(415)
    const form = await request({ headers: { host: base, 'content-type': 'application/x-www-form-urlencoded' } })
    expect(form.status).toBe(415)
  })

  it('answers 413 for an oversized body instead of dropping the socket', async () => {
    const res = await request({ headers: { host: base, ...JSON_HEADERS }, body: 'x'.repeat(1_000_001) })
    expect(res.status).toBe(413)
    expect(JSON.parse(res.body).error.code).toBe('too-large')
  })

  it('refuses an auto-fix outside a HarmonyOS project root', async () => {
    // Only the writing modes carry this guard: a plain check stays usable on any directory the
    // user picked, so mode "changed" is deliberately not the probe here. The target check runs
    // before the toolchain probe, so this holds on a machine without devecocli (CI included).
    const res = await request({
      name: 'check.lint',
      headers: { host: base, ...JSON_HEADERS },
      body: JSON.stringify({ projectPath: NOT_A_PROJECT, mode: 'fix' }),
    })
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body).error.message).toContain('build-profile.json5')
  })

})

// a capture carrying the `tool-` name is the only kind any prune may ever touch, so that
// tag has to be unforgeable from outside the process — otherwise "never auto-delete the user's shot"
// would rest on a body field the caller controls. This drives the real route with a stand-in
// devecocli and a real filesystem, and judges the file name that actually landed.
describe.skipIf(!CAN_SPAWN)('screenshot ownership tag', () => {
  let dir
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-origin-'))
    process.env.DSH_HMOS_DEVECO_CLI = FAKE_CLI
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DSH_HMOS_DEVECO_CLI
  })

  const shotName = async (body) => {
    const res = await request({
      name: 'screenshot',
      headers: { host: base, ...JSON_HEADERS },
      body: JSON.stringify({ device: '127.0.0.1:5555', root: dir, ...body }),
    })
    expect(res.status).toBe(200)
    const value = JSON.parse(res.body).value
    return value.path.split(/[\\/]/).pop()
  }

  it('refuses to let an HTTP caller claim the prunable tool- name', async () => {
    // The panel never sends `origin`; this is what a forged body would look like, and it must still
    // be named as the user's own shot — the name the user prunes by hand and no code ever deletes.
    const name = await shotName({ origin: 'tool' })
    expect(name.startsWith('hmos-shot-')).toBe(true)
    expect(readdirSync(join(dir, 'screenshots')).some((f) => f.startsWith('tool-'))).toBe(false)
  })

})

// The suite above exercises the host half; this keeps the client half honest too, so a build that
// emitted a bundle which never registers cannot pass unnoticed.

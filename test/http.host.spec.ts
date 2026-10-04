/**
 * The HTTP API the panel talks to: trust fence, envelope, body limits, and the names the route
 * writes on disk. A new case belongs here when it goes over the real route, never in-process.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mountPlugin } from './harness.js'

/** This spec's own directory: exists, and is never a HarmonyOS project root. */
const NOT_A_PROJECT = dirname(fileURLToPath(import.meta.url))
const FAKE_CLI = join(NOT_A_PROJECT, 'fake-devecocli.js')
/** Spawning is what a confined sandbox refuses (piped stdio EPERM); skip rather than misreport. */
const CAN_SPAWN = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' }).status === 0

/**
 * The trust fence has to be applied by the route handler, not merely exist: the unit tests for
 * isTrustedRequest would still pass if a refactor dropped the call. This mounts the real prefix
 * route on a real HTTP server and judges it by observed status codes.
 */
let server
let port
let base

/** The trust list DSH publishes (`webRuntime`); the fence must follow it, per request. */
const webRuntime = { lanAddresses: [], trustedHosts: [] }

/** Mount the plugin the way the host does: webServer and webRuntime handed to apply(). */
function mount() {
  return mountPlugin({ webRuntime }).routes[0]
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

// The panel asks for the toolchain report on every open, and producing it costs a devecocli spawn
// (~0.6 s, mostly Node startup) — the biggest single part of its first-paint wait. So the host
// caches it, while the panel's 刷新 button and the install/update path must still be able to force
// a fresh probe. The spawn count is the observable: the stand-in CLI logs every argv it is given.
describe.skipIf(!CAN_SPAWN)('toolchain report cache', () => {
  let dir
  let log
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-toolchain-'))
    log = join(dir, 'argv.log')
    process.env.DSH_HMOS_DEVECO_CLI = FAKE_CLI
    process.env.DSH_FAKE_ARGV_LOG = log
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.DSH_HMOS_DEVECO_CLI
    delete process.env.DSH_FAKE_ARGV_LOG
  })

  const probes = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line.includes('--version')).length : 0)
  const toolchain = async (body) => {
    const res = await request({ name: 'toolchain', headers: { host: base, ...JSON_HEADERS }, body: JSON.stringify(body) })
    expect(res.status).toBe(200)
    return JSON.parse(res.body).value
  }

  it('probes once, then serves the cache until refresh is asked for', async () => {
    const first = await toolchain({ refresh: true })
    const afterProbe = probes()
    expect(afterProbe).toBeGreaterThan(0)
    expect(first.devecoCliJs).toBe(FAKE_CLI)
    // Two more reads ride the cache: the panel opens often, the answer barely changes.
    expect((await toolchain({})).devecoCliJs).toBe(FAKE_CLI)
    expect((await toolchain({})).devecoCliJs).toBe(FAKE_CLI)
    expect(probes()).toBe(afterProbe)
    await toolchain({ refresh: true })
    expect(probes()).toBe(afterProbe + 1)
  })
})

// The panel-only routes. Nothing else in the suite would notice one of these breaking: the model
// tools have their own paths through `api`, `deploy` reuses this route, and the fence cases above
// never reach a handler. They run against the stand-in devecocli and a real temporary directory.
//
// `deveco.install` is deliberately not covered: it shells out to `npm install -g`, which would reach
// the network and mutate the machine running the suite.
describe.skipIf(!CAN_SPAWN)('panel-only routes', () => {
  let dir
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-panel-routes-'))
    process.env.DSH_HMOS_DEVECO_CLI = FAKE_CLI
  })
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (key.startsWith('DSH_FAKE_')) delete process.env[key]
    delete process.env.DSH_HMOS_DEVECO_CLI
  })

  /** One accepted POST, unwrapped; the assertion message carries the route that failed. */
  const call = async (name, body = {}) => {
    const res = await request({ name, headers: { host: base, ...JSON_HEADERS }, body: JSON.stringify(body ?? {}) })
    expect(res.status, `${name} -> ${res.body}`).toBe(200)
    return JSON.parse(res.body).value
  }
  const post = (name, body = {}) => request({ name, headers: { host: base, ...JSON_HEADERS }, body: JSON.stringify(body ?? {}) })

  it('normalizes the emulator list, and reports what it could not parse', async () => {
    // The real command mixes log lines around the JSON array, which is why the handler slices it;
    // an entry without a name is dropped, and a broken body must surface as parseError instead of
    // an empty list that reads like "no emulators installed".
    process.env.DSH_FAKE_INSTANCES = 'warning: profile loaded\n[{"name":"Pixel","status":"running","serial":"emulator-5554","deviceType":"phone","osVersion":"5.0.0"},{"status":"offline"}]\n'
    const listed = await call('emu.list')
    expect(listed.code).toBe(0)
    expect(listed.instances).toEqual([
      { name: 'Pixel', status: 'running', serial: 'emulator-5554', deviceType: 'phone', osVersion: '5.0.0' },
    ])
    // Brackets complete but the JSON is not: this is the branch that must report parseError.
    process.env.DSH_FAKE_INSTANCES = '[{"name": "Pixel",}]'
    const broken = await call('emu.list')
    expect(broken.instances).toEqual([])
    expect(broken.parseError).toBeTruthy()
    delete process.env.DSH_FAKE_INSTANCES
  })

  it('lists devices in both accepted shapes and judges readiness by membership', async () => {
    process.env.DSH_FAKE_DEVICES = '["127.0.0.1:5555",{"serial":"ABC123"}]'
    const listed = await call('devices')
    expect(listed.devices).toEqual(['127.0.0.1:5555', 'ABC123'])
    expect(listed.hdcError).toBeNull()
    expect((await call('device.ready', { serial: 'ABC123' })).online).toBe(true)
    // An offline serial still reports the list: the panel shows it instead of guessing.
    expect(await call('device.ready', { serial: 'nope:1' }))
      .toEqual({ online: false, serial: 'nope:1', devices: ['127.0.0.1:5555', 'ABC123'] })
    // A body without a serial is a caller mistake, not an offline device.
    expect((await post('device.ready', {})).status).toBe(400)
    process.env.DSH_FAKE_DEVICES = 'not json'
    expect((await call('devices')).hdcError).toContain('解析失败')
    delete process.env.DSH_FAKE_DEVICES
  })

  it('refuses to start an instance whose system image is not downloaded', async () => {
    // The pre-check exists so a miss returns the exact download command instead of the CLI's raw
    // "cannot be found": the panel shows that message, so it is part of the route's contract.
    process.env.DSH_FAKE_INSTANCES = '[{"name":"Pixel","osVersion":"5.0.0","deviceType":"phone"}]'
    process.env.DSH_FAKE_IMAGES = '[]'
    const res = await post('emu.start', { name: 'Pixel' })
    expect(res.status).toBe(400)
    const error = JSON.parse(res.body).error
    expect(error.code).toBe('image-missing')
    expect(error.message).toContain('emulator image download')
    delete process.env.DSH_FAKE_INSTANCES
    delete process.env.DSH_FAKE_IMAGES
  })

  it('starts and stops an instance, and never reports readiness it did not observe', async () => {
    process.env.DSH_FAKE_INSTANCES = '[{"name":"Pixel","serial":"emulator-5554","status":"running"}]'
    process.env.DSH_FAKE_DEVICES = '["emulator-5554"]'
    expect(await call('emu.start', { name: 'Pixel' }))
      .toMatchObject({ code: 0, ready: true, serial: 'emulator-5554' })
    // A start that failed must not claim a serial, and a stop that failed keeps its exit code.
    process.env.DSH_FAKE_START_CODE = '1'
    expect(await call('emu.start', { name: 'Pixel' }))
      .toMatchObject({ code: 1, ready: false, serial: null })
    delete process.env.DSH_FAKE_START_CODE
    expect((await post('emu.start', {})).status).toBe(400)
    process.env.DSH_FAKE_STOP_CODE = '1'
    expect((await call('emu.stop', { target: 'Pixel' })).code).toBe(1)
    delete process.env.DSH_FAKE_STOP_CODE
    expect((await post('emu.stop', {})).status).toBe(400)
    delete process.env.DSH_FAKE_INSTANCES
    delete process.env.DSH_FAKE_DEVICES
  })

  it('finds project roots under a directory, and never descends into one', async () => {
    mkdirSync(join(dir, 'app-a'), { recursive: true })
    writeFileSync(join(dir, 'app-a', 'build-profile.json5'), '{}')
    mkdirSync(join(dir, 'nested', 'app-b'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'app-b', 'build-profile.json5'), '{}')
    mkdirSync(join(dir, 'plain'), { recursive: true })
    const found = await call('scan', { root: dir })
    expect(found.root).toBe(dir)
    expect(found.projects.sort()).toEqual([join(dir, 'app-a'), join(dir, 'nested', 'app-b')].sort())
    // A module carries the same marker, so scanning inside a project must not list its modules as
    // projects — that is what would aim a deploy at `entry` instead of the project.
    mkdirSync(join(dir, 'app-a', 'entry'), { recursive: true })
    writeFileSync(join(dir, 'app-a', 'entry', 'build-profile.json5'), '{}')
    expect((await call('scan', { root: join(dir, 'app-a') })).projects).toEqual([join(dir, 'app-a')])
  })

  it('streams a deploy and ends with its exit marker', async () => {
    // The panel reads this response as it arrives, so the route owns the response instead of the
    // JSON envelope. The model tools call the same api method without a res (buffered path), which
    // is why this streaming branch needs its own case: nothing else reaches it.
    mkdirSync(join(dir, 'app'), { recursive: true })
    writeFileSync(join(dir, 'app', 'build-profile.json5'), '{}')
    process.env.DSH_FAKE_DEVICES = '["emulator-5554"]'
    const res = await request({
      name: 'deploy',
      headers: { host: base, ...JSON_HEADERS },
      body: JSON.stringify({ projectPath: join(dir, 'app'), device: 'emulator-5554' }),
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('[dsh-hmos-emulator] 部署 emulator-5554')
    expect(res.body).toContain('[HMOS_EXIT]=0')
    // An offline device is refused before a build that takes minutes.
    process.env.DSH_FAKE_DEVICES = '[]'
    const offline = await post('deploy', { projectPath: join(dir, 'app'), device: 'emulator-5554' })
    expect(offline.status).toBe(400)
    expect(JSON.parse(offline.body).error.code).toBe('device-offline')
    delete process.env.DSH_FAKE_DEVICES
  })

  it('queues the check result only after a check, and reports an update honestly', async () => {
    // Nothing has run a check in this fresh plugin instance, so the panel's "send to AI" must be
    // refused with the reason rather than queueing an empty notice.
    expect((await post('lint.notify', {})).status).toBe(400)
    // A plain check is enough to fill it (the stand-in CLI answers with no parseable summary).
    await call('check.lint', { projectPath: NOT_A_PROJECT, mode: 'changed' })
    const queued = await call('lint.notify', { sessionId: 'session-1' })
    expect(queued.sent).toBe(true)
    expect(queued.bytes).toBeGreaterThan(0)
    process.env.DSH_FAKE_UPDATE_CODE = '1'
    const updated = await call('deveco.update')
    expect(updated.code).toBe(1)
    expect(updated.note).toContain('更新失败')
    delete process.env.DSH_FAKE_UPDATE_CODE
  })
})

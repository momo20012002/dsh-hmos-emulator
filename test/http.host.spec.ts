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
    // The same report carries the login state the panel shows beside the version, from the same cache.
    expect(first.signedIn).toBe(true)
    // Two more reads ride the cache: the panel opens often, the answer barely changes.
    expect((await toolchain({})).devecoCliJs).toBe(FAKE_CLI)
    expect((await toolchain({})).devecoCliJs).toBe(FAKE_CLI)
    expect(probes()).toBe(afterProbe)
    await toolchain({ refresh: true })
    expect(probes()).toBe(afterProbe + 1)
  })

  it("reports a signed-out account from the verb's words, not its exit code", async () => {
    // Measured on devecocli 1.3.4: `auth status` exits 0 even while it prints `Not logged in`, so the state
    // has to be read from the text. This is the machine a failed `sign` and the panel hint are both about.
    process.env.DSH_FAKE_AUTH = 'Not logged in\n'
    try {
      expect((await toolchain({ refresh: true })).signedIn).toBe(false)
    } finally {
      delete process.env.DSH_FAKE_AUTH
    }
  })

  it('reports an account state it could not read as unknown, never as signed out', async () => {
    // A run that failed outright (non-zero exit, spawn failure, or the timeout) never read the state, so the
    // row must say "状态未知" and a failed `sign` must not blame the account.
    process.env.DSH_FAKE_AUTH_CODE = '1'
    try {
      expect((await toolchain({ refresh: true })).signedIn).toBe(null)
    } finally {
      delete process.env.DSH_FAKE_AUTH_CODE
    }
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

  it('runs one emulator control, with the argv the model tool builds', async () => {
    // Rotate, power and volume are the tool's own three argument-free verbs: one argv each pins that
    // the panel's route and tools/emu.ts keep building the same request.
    const argvLog = join(dir, 'emu-control-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    expect(await call('emu.control', { target: 'Pura 90', action: 'rotate', direction: 'left' }))
      .toMatchObject({ code: 0, action: 'rotate', target: 'Pura 90' })
    expect(await call('emu.control', { target: 'Pura 90', action: 'power' })).toMatchObject({ code: 0, action: 'power' })
    expect(readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      ['emulator', 'rotate', '--target', 'Pura 90', 'left'],
      ['emulator', 'power', '--target', 'Pura 90'],
    ])
    // A direction the CLI does not take for that verb is answered here, before a spawn, in the wording
    // the panel shows — not by the CLI's own option error after a round trip.
    const wrong = await post('emu.control', { target: 'Pura 90', action: 'volume', direction: 'left' })
    expect(wrong.status).toBe(400)
    expect(JSON.parse(wrong.body).error.message).toContain('音量只支持')
    expect((await post('emu.control', { target: 'Pura 90', action: 'battery' })).status).toBe(400)
    expect((await post('emu.control', { action: 'power' })).status).toBe(400)
    delete process.env.DSH_FAKE_ARGV_LOG
  })

  it('moves one file each way, with the argv the model tool builds', async () => {
    // One command read in two directions: the local end stays last for send and leads for recv. This
    // line is what keeps the panel's route and tools/device.ts from drifting apart.
    const argvLog = join(dir, 'device-file-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    const local = join(dir, 'upload.txt')
    writeFileSync(local, 'hello')
    const sent = await call('device.file', { direction: 'send', device: 'emulator-5554', local, remote: '/data/local/tmp/x.txt' })
    expect(sent).toMatchObject({ direction: 'send', local, remote: '/data/local/tmp/x.txt' })
    const into = join(dir, 'pulled', 'x.txt')
    expect((await call('device.file', { direction: 'recv', device: 'emulator-5554', local: into, remote: '/data/local/tmp/x.txt' })).local).toBe(into)
    // A download makes its own directory: the caller names the file, not the path to it.
    expect(existsSync(dirname(into))).toBe(true)
    expect(readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      ['device', 'file', 'send', '--device', 'emulator-5554', local, '/data/local/tmp/x.txt'],
      ['device', 'file', 'recv', '--device', 'emulator-5554', '/data/local/tmp/x.txt', into],
    ])
    // A relative local path is read against the workspace the panel names, not against the host's cwd.
    const relative = await call('device.file', { direction: 'send', device: 'emulator-5554', local: 'upload.txt', remote: '/data/local/tmp/x.txt', root: dir })
    expect(relative.local).toBe(local)
    // Every refusal the route can give without a device round trip, and without spawning anything.
    expect((await post('device.file', { direction: 'send', device: 'emulator-5554', local: join(dir, 'missing.txt'), remote: '/data/x' })).status).toBe(400)
    expect((await post('device.file', { direction: 'sideways', device: 'emulator-5554', local, remote: '/data/x' })).status).toBe(400)
    expect((await post('device.file', { direction: 'recv', device: 'emulator-5554', local: into, remote: '' })).status).toBe(400)
    expect((await post('device.file', { direction: 'send', local, remote: '/data/x' })).status).toBe(400)
    // A directory is not a file to upload. The panel's own chooser picks directories, so this is the mistake
    // that actually happens — saying so beats a device round trip that fails inside the CLI.
    const asDir = await post('device.file', { direction: 'send', device: 'emulator-5554', local: dir, remote: '/data/x' })
    expect(asDir.status).toBe(400)
    expect(JSON.parse(asDir.body).error.message).toContain('文件夹')
    // A save path that cannot be created is the caller's mistake too, and must not surface as a 500: `blocked`
    // is a file, so nothing can be created inside it.
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x')
    const noParent = await post('device.file', { direction: 'recv', device: 'emulator-5554', local: join(blocked, 'y.txt'), remote: '/data/x' })
    expect(noParent.status).toBe(400)
    expect(JSON.parse(noParent.body).error.code).toBe('fs-error')
    // A relative path with no workspace to read it against is a refusal, not a guess at the host's cwd.
    // The message is what pins that: a missing file also answers 400, so the status alone cannot tell
    // the two refusals apart.
    const noRoot = await post('device.file', { direction: 'send', device: 'emulator-5554', local: 'upload.txt', remote: '/data/x' })
    expect(noRoot.status).toBe(400)
    expect(JSON.parse(noRoot.body).error.message).toContain('工作区根目录')
    delete process.env.DSH_FAKE_ARGV_LOG
  })

  it('writes the panel log into the folder the panel chose', async () => {
    // The panel holds the lines — they arrived as streamed CLI output — so this route is only the writer:
    // the folder arrives with the request, and the name carries the device and the moment.
    const saved = await call('log.export', { dir, device: 'emulator-5554', text: 'line one\nline two\n' })
    expect(dirname(saved.path)).toBe(dir)
    expect(saved.path.endsWith('.log')).toBe(true)
    expect(saved.path).toContain('emulator-5554')
    expect(saved.bytes).toBe(18)
    expect(readFileSync(saved.path, 'utf8')).toBe('line one\nline two\n')
    // Nothing to save, and nowhere to save it, are both refused before anything is written.
    expect((await post('log.export', { dir, text: '   ' })).status).toBe(400)
    expect((await post('log.export', { text: 'x' })).status).toBe(400)
    expect((await post('log.export', { dir: join(dir, 'not-there'), text: 'x' })).status).toBe(400)
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
    expect(res.body).toContain('[dsh-hmos-emulator] 构建并部署到 emulator-5554')
    expect(res.body).toContain('[HMOS_EXIT]=0')
    // An offline device is refused before a build that takes minutes.
    process.env.DSH_FAKE_DEVICES = '[]'
    const offline = await post('deploy', { projectPath: join(dir, 'app'), device: 'emulator-5554' })
    expect(offline.status).toBe(400)
    expect(JSON.parse(offline.body).error.code).toBe('device-offline')
    // `clean` shares the route but touches no device, so the same offline state must not stop it.
    const cleaned = await request({
      name: 'deploy',
      headers: { host: base, ...JSON_HEADERS },
      body: JSON.stringify({ projectPath: join(dir, 'app'), device: 'emulator-5554', mode: 'clean' }),
    })
    expect(cleaned.status).toBe(200)
    expect(cleaned.body).toContain('[dsh-hmos-emulator] 清理构建')
    expect(cleaned.body).toContain('[HMOS_EXIT]=0')
    // A module this project does not have is refused, and several modules are handed over in order.
    writeFileSync(join(dir, 'app', 'build-profile.json5'), '{"modules":[{"name":"entry"},{"name":"common"}]}')
    const bad = await post('deploy', { projectPath: join(dir, 'app'), device: 'emulator-5554', modules: ['nope'] })
    expect(bad.status).toBe(400)
    const built = await request({
      name: 'deploy',
      headers: { host: base, ...JSON_HEADERS },
      body: JSON.stringify({ projectPath: join(dir, 'app'), device: 'emulator-5554', modules: ['entry', 'common'], buildOnly: true }),
    })
    expect(built.status).toBe(200)
    expect(built.body).toContain('[dsh-hmos-emulator] 构建(模块 entry)')
    delete process.env.DSH_FAKE_DEVICES
  })

  it('builds without a device, and hands build the flag it really has', async () => {
    // Build-only and clean never reach a device, so neither may be blocked by "pick a device" — and the
    // build verb takes `--modules` (`--module` is the run verb's, which is what this route used to send).
    mkdirSync(join(dir, 'b'), { recursive: true })
    writeFileSync(join(dir, 'b', 'build-profile.json5'), '{"modules":[{"name":"entry"}]}')
    const argvLog = join(dir, 'build-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    const built = await request({
      name: 'deploy',
      headers: { host: base, ...JSON_HEADERS },
      body: JSON.stringify({ projectPath: join(dir, 'b'), buildOnly: true }),
    })
    expect(built.status).toBe(200)
    expect(built.body).toContain('构建(模块 entry)')
    const cleaned = await request({
      name: 'deploy',
      headers: { host: base, ...JSON_HEADERS },
      body: JSON.stringify({ projectPath: join(dir, 'b'), mode: 'clean' }),
    })
    expect(cleaned.status).toBe(200)
    expect(cleaned.body).toContain('清理构建')
    // A boolean spelled as a word is what prompts and scripts send: it must not turn build into a deploy.
    const spelled = await request({
      name: 'deploy',
      headers: { host: base, ...JSON_HEADERS },
      body: JSON.stringify({ projectPath: join(dir, 'b'), buildOnly: 'true' }),
    })
    expect(spelled.status).toBe(200)
    expect(spelled.body).toContain('构建(模块 entry)')
    const argvs = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(argvs[0]).toEqual(['build', '--modules', 'entry'])
    expect(argvs[1]).toEqual(['build', 'clean'])
    expect(argvs[2]).toEqual(['build', '--modules', 'entry'])
    delete process.env.DSH_FAKE_ARGV_LOG
  })

  it('streams a log follow and closes when the CLI is done', async () => {
    // The follow route owns its response the way the deploy route does. A CLI that prints and exits must
    // close it instead of leaving the panel waiting for a stream that will never end.
    process.env.DSH_FAKE_LOG = '01-01 00:00:00.000  1  1 I A/B: hello\n'
    const res = await request({
      name: 'log.follow',
      headers: { host: base, ...JSON_HEADERS },
      body: JSON.stringify({ device: 'emulator-5554' }),
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('实时监听 emulator-5554')
    expect(res.body).toContain('A/B: hello')
    delete process.env.DSH_FAKE_LOG
  })

  it('runs a deploy without building when the panel asks for that', async () => {
    // The fourth action maps to `run --skip-build` — the same argv the model tool builds for skipBuild.
    mkdirSync(join(dir, 'skip'), { recursive: true })
    writeFileSync(join(dir, 'skip', 'build-profile.json5'), '{}')
    const argvLog = join(dir, 'skip-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    process.env.DSH_FAKE_DEVICES = '["emulator-5554"]'
    const res = await request({
      name: 'deploy',
      headers: { host: base, ...JSON_HEADERS },
      body: JSON.stringify({ projectPath: join(dir, 'skip'), device: 'emulator-5554', mode: 'skipbuild' }),
    })
    expect(res.status).toBe(200)
    expect(res.body).toContain('[dsh-hmos-emulator] 部署(不构建)到 emulator-5554')
    expect(res.body).toContain('未重新构建')
    const argvLines = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(argvLines[argvLines.length - 1]).toEqual(['run', '--device', 'emulator-5554', '--skip-build'])
    delete process.env.DSH_FAKE_ARGV_LOG
    delete process.env.DSH_FAKE_DEVICES
  })

  it('answers a log snapshot with the same flags the model tool uses', async () => {
    // One argv pins the contract: if the panel's flags drift from tools/log.ts, this line moves too.
    const argvLog = join(dir, 'log-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    process.env.DSH_FAKE_INSTANCES = '[{"name":"Pura 90","status":"running","serial":"127.0.0.1:5555"}]'
    process.env.DSH_FAKE_LOG = 'D 05:00:00.000   123  A00000  [tag] hello'
    const r = await post('log.snapshot', { level: 'W', bundle: 'io.github.x.y', tail: 7, keyword: 'hello', from: '5m' })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body).value.output).toContain('hello')
    // The device lookup is its own CLI call, so the snapshot is the last argv on record.
    const argvLines = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(argvLines[argvLines.length - 1]).toEqual([
      'log', '--device', '127.0.0.1:5555', '--tail', '7', '--level', 'W', '--bundle-name', 'io.github.x.y',
      '--keyword', 'hello', '--from', '5m',
    ])
    // No running instance and no explicit device: say why rather than return an empty log.
    process.env.DSH_FAKE_INSTANCES = '[]'
    const none = await post('log.snapshot', {})
    expect(none.status).toBe(400)
    expect(JSON.parse(none.body).error.code).toBe('device-offline')
    delete process.env.DSH_FAKE_ARGV_LOG
    delete process.env.DSH_FAKE_INSTANCES
    delete process.env.DSH_FAKE_LOG
  })

  it('reads the latest lines for the current-time choice, with no window at all', async () => {
    // 当前时间 (`1s`) means the latest lines: a snapshot is asked for because something is on screen, and a
    // one-second window would come back empty whenever that second was quiet.
    const argvLog = join(dir, 'log-now-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    process.env.DSH_FAKE_INSTANCES = '[{"name":"Pura 90","status":"running","serial":"127.0.0.1:5555"}]'
    process.env.DSH_FAKE_LOG = '10-13 00:00:01.000     1     1 I A/B: one\n10-13 00:00:02.000     1     1 I A/B: two'
    try {
      const r = await post('log.snapshot', { tail: 2, from: '1s' })
      expect(r.status).toBe(200)
      expect(JSON.parse(r.body).value.output).toContain('A/B: two')
      const argvLines = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(argvLines[argvLines.length - 1]).toEqual(['log', '--device', '127.0.0.1:5555', '--tail', '2'])
    } finally {
      delete process.env.DSH_FAKE_ARGV_LOG
      delete process.env.DSH_FAKE_INSTANCES
      delete process.env.DSH_FAKE_LOG
    }
  })

  it('treats an empty start as the current time, which is what the panel falls back to', async () => {
    // A choice stored before 当前时间 existed is empty, and the row now always sends a real value, so this
    // keeps the route total if one ever arrives without it.
    const argvLog = join(dir, 'log-empty-argv.log')
    process.env.DSH_FAKE_ARGV_LOG = argvLog
    process.env.DSH_FAKE_INSTANCES = '[{"name":"Pura 90","status":"running","serial":"127.0.0.1:5555"}]'
    process.env.DSH_FAKE_LOG = '10-13 00:00:02.000     1     1 I A/B: two'
    try {
      const r = await post('log.snapshot', { tail: 2, from: '' })
      expect(r.status).toBe(200)
      expect(JSON.parse(r.body).value.output).toContain('A/B: two')
      const argvLines = readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      expect(argvLines[argvLines.length - 1]).toEqual(['log', '--device', '127.0.0.1:5555', '--tail', '2'])
    } finally {
      delete process.env.DSH_FAKE_ARGV_LOG
      delete process.env.DSH_FAKE_INSTANCES
      delete process.env.DSH_FAKE_LOG
    }
  })

  it('queues the check result only after a check, and upgrades devecocli on the installed channel', async () => {
    // Nothing has run a check in this fresh plugin instance, so the panel's "send to AI" must be
    // refused with the reason rather than queueing an empty notice.
    expect((await post('lint.notify', {})).status).toBe(400)
    // A plain check is enough to fill it (the stand-in CLI answers with no parseable summary).
    await call('check.lint', { projectPath: NOT_A_PROJECT, mode: 'changed' })
    const queued = await call('lint.notify', { sessionId: 'session-1' })
    expect(queued.sent).toBe(true)
    expect(queued.bytes).toBeGreaterThan(0)
    // The upgrade follows the channel the installed build came from: `devecocli update` itself only
    // ever targets `latest`, so the plugin drives npm with a pinned dist-tag instead.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmos-npm-'))
    const argvLog = join(dir, 'argv.log')
    process.env.DSH_HMOS_DEVECO_CLI = FAKE_CLI
    process.env.DSH_HMOS_NPM = join(NOT_A_PROJECT, 'fake-npm.js')
    process.env.DSH_FAKE_NPM_LOG = argvLog
    try {
      process.env.DSH_FAKE_VERSION = '1.3.0-stable'
      // The confirmation is planned first: it names the build the chosen channel points at, and the
      // registry answer turns that tag into a version — even when npm's own warning sits above it,
      // because runCli merges stderr into the same buffer the answer arrives on.
      process.env.DSH_FAKE_NPM_VIEW_WARN = 'npm warn Unknown env config "manage-package-manager-versions". This will stop working in the next major version of npm.'
      const plan = await call('deveco.plan', { channel: 'latest' })
      expect(plan).toMatchObject({ channel: 'latest', spec: '@deveco/deveco-cli@latest', installed: '1.3.0-stable', target: '1.3.4', checked: true })
      delete process.env.DSH_FAKE_NPM_VIEW_WARN
      // A lookup the host cannot complete reads as unknown, never as a version.
      process.env.DSH_FAKE_NPM_VIEW_CODE = '1'
      const unknown = await call('deveco.plan', {})
      expect(unknown).toMatchObject({ checked: false, target: null, channel: 'stable' })
      delete process.env.DSH_FAKE_NPM_VIEW_CODE
      const stable = await call('deveco.update')
      expect(stable.code).toBe(0)
      expect(stable.channel).toBe('stable')
      expect(stable.spec).toBe('@deveco/deveco-cli@stable')
      expect(stable.note).toContain('@deveco/deveco-cli@stable')
      // The stable install must not be moved onto the latest line.
      process.env.DSH_FAKE_VERSION = '1.3.4'
      const latest = await call('deveco.update')
      expect(latest.channel).toBe('latest')
      expect(latest.spec).toBe('@deveco/deveco-cli@latest')
      // An explicit choice — the panel's channel switch — wins over the installed one, which is the
      // only way a stable machine can be moved onto latest on purpose.
      process.env.DSH_FAKE_VERSION = '1.3.0-stable'
      const forced = await call('deveco.update', { channel: 'latest' })
      expect(forced.channel).toBe('latest')
      expect(forced.spec).toBe('@deveco/deveco-cli@latest')
      // Every call the plugin made, in order: the two plans ask the registry, the updates install.
      expect(readFileSync(argvLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
        ['view', '@deveco/deveco-cli@latest', 'version'],
        ['view', '@deveco/deveco-cli@stable', 'version'],
        ['install', '-g', '@deveco/deveco-cli@stable'],
        ['install', '-g', '@deveco/deveco-cli@latest'],
        ['install', '-g', '@deveco/deveco-cli@latest'],
      ])
      // A failed install is reported as a failure, not as a silent success.
      process.env.DSH_FAKE_UPDATE_CODE = '1'
      const updated = await call('deveco.update')
      expect(updated.code).toBe(1)
      expect(updated.note).toContain('更新失败')
    } finally {
      delete process.env.DSH_FAKE_UPDATE_CODE
      delete process.env.DSH_FAKE_VERSION
      delete process.env.DSH_FAKE_NPM_LOG
      delete process.env.DSH_HMOS_NPM
      delete process.env.DSH_HMOS_DEVECO_CLI
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

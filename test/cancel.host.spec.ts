/**
 * Cancellation, end to end in two deterministic pieces: closing the panel response aborts the
 * route's controller, and an aborted signal kills the child a build was running in (terminating
 * first, then escalating, because a build that ignores the polite signal keeps the device locked).
 * The two are composed here because a real 20-minute build cannot be awaited in a test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiRoute } from '../src/http.js'
import { runCli, waitDeviceReady } from '../src/toolchain.js'
import { mountPlugin } from './harness.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_CLI = join(HERE, 'fake-devecocli.js')
const CAN_SPAWN = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' }).status === 0

let dir: string
let argvLog: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-cancel-'))
  argvLog = join(dir, 'argv.log')
  process.env.DSH_HMOS_DEVECO_CLI = FAKE_CLI
  process.env.DSH_FAKE_ARGV_LOG = argvLog
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const key of Object.keys(process.env)) if (key.startsWith('DSH_FAKE_')) delete process.env[key]
  delete process.env.DSH_HMOS_DEVECO_CLI
})

/** Every argv the stand-in CLI was asked to run: proof that a cancelled call spawned nothing. */
const spawns = () => (existsSync(argvLog) ? readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean) : [])

/** A POST request the route accepts: loopback Host, JSON, and an empty body. */
function fakeRequest() {
  const req: any = new EventEmitter()
  req.method = 'POST'
  req.url = '/dsh-hmos-emulator/api/project.info'
  req.headers = { host: '127.0.0.1', 'content-type': 'application/json' }
  req.resume = () => {}
  setImmediate(() => req.emit('end'))
  return req
}

/** A response that records what was written and can announce that the client went away. */
function fakeResponse() {
  const res: any = new EventEmitter()
  res.writableEnded = false
  res.headersSent = false
  res.body = ''
  res.writeHead = () => { res.headersSent = true }
  res.write = (chunk: string) => { res.body += chunk; return true }
  res.end = () => { res.writableEnded = true }
  return res
}

describe('route cancellation', () => {
  it('aborts the controller when the client goes away, and leaves it alone when the answer is sent', async () => {
    const seen: any[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const api = {
      'project.info': async (_payload: any, _res: any, ctl: any) => {
        seen.push(ctl?.signal)
        // Hold the route open, so `close` arrives while it is still listening: this is the state a
        // 20-minute build is in when the user closes the panel.
        await gate
        return { ok: true }
      },
    }
    const route = createApiRoute({ api, ctx: { get: () => undefined }, host: '127.0.0.1' })

    const closed = fakeResponse()
    const pending = route(fakeRequest(), closed)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen[0].aborted).toBe(false)
    closed.emit('close')
    expect(seen[0].aborted).toBe(true)
    release()
    await pending

    // A response that ends normally removes the listener, so a later `close` cannot cancel anything.
    const ended = fakeResponse()
    await route(fakeRequest(), ended)
    ended.writableEnded = true
    ended.emit('close')
    expect(seen[1].aborted).toBe(false)
  })
})

describe.skipIf(!CAN_SPAWN)('process cancellation', () => {
  it('never spawns a command whose caller already cancelled', async () => {
    const result = await runCli([process.execPath, FAKE_CLI, 'build'], { signal: AbortSignal.abort() })
    expect(result).toMatchObject({ aborted: true, timedOut: false, code: null })
    expect(result.output).toContain('已取消')
    expect(spawns()).toEqual([])
  })

  it('terminates a running build on abort, escalating past a child that ignores SIGTERM', async () => {
    const controller = new AbortController()
    process.env.DSH_FAKE_SLEEP_MS = '30000'
    process.env.DSH_FAKE_STUBBORN = '1'
    const started = Date.now()
    setTimeout(() => controller.abort(), 150)
    const result = await runCli([process.execPath, FAKE_CLI, 'run', '--device', 'x'], {
      signal: controller.signal,
      graceMs: 150,
    })
    expect(result.aborted).toBe(true)
    // Aborted, not timed out: the caller asked, and the wait ended long before the child would have.
    expect(result.timedOut).toBe(false)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(spawns()).toHaveLength(1)
  })

  it('refuses an aborted tool call, and stops an aborted device wait without polling', async () => {
    const { tools } = mountPlugin()
    const deploy = tools.find((def) => def.name === 'hmos_deploy')
    // Pre-flight: a cancelled tool call does no filesystem work, no probe, no build.
    await expect(deploy.execute({ projectPath: dir }, { signal: AbortSignal.abort() }))
      .rejects.toMatchObject({ code: 'ABORTED' })
    const waited = await waitDeviceReady(FAKE_CLI, 'Pixel', { signal: AbortSignal.abort() })
    expect(waited).toEqual({ ready: false, serial: null, aborted: true })
    expect(spawns()).toEqual([])
  })
})

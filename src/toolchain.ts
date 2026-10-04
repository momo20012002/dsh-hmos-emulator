import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
/**
 * Locating and running the external CLIs (devecocli, hdc): path probes, wrapper unwrapping,
 * command execution, plus the emulator/device readiness probes built on top of them.
 */
/** Retained output cap (tail only, so a huge build log cannot flood the browser). */
export const OUTPUT_TAIL = 80000

// ── Toolchain discovery ─────────────────────────────────────────────────

/** Run a command and return its first non-empty line (used by where/which probes). */
export function whichFirst(bare) {
  try {
    const probe = process.platform === 'win32' ? 'where.exe' : 'which'
    const out = spawnSync(probe, [bare], { encoding: 'utf8', windowsHide: true })
    if (out.status !== 0) return undefined
    const line = String(out.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0)
    return line
  } catch {
    return undefined
  }
}

/** Derive the @deveco/deveco-cli node entry from an npm global root. */
export function cliUnderNpmRoot(npmRoot) {
  if (!npmRoot) return undefined
  const cli = join(npmRoot, 'node_modules', '@deveco', 'deveco-cli', 'dist', 'cli.js')
  return existsSync(cli) ? cli : undefined
}

/**
 * The JS entry a devecocli path stands for. `npm i -g` writes `devecocli.cmd` / `.ps1` / an
 * extension-less sh shim side by side in the global bin dir, and each is only a launcher whose last
 * line runs `<its dir>/node_modules/@deveco/deveco-cli/dist/cli.js`. Node cannot spawn such a
 * wrapper — a `.cmd` needs a shell, and going through cmd.exe would re-quote the Chinese labels and
 * regexes this plugin passes — so a wrapper is traced to its target and never executed.
 */
export function cliFromWrapper(candidate: string): string | undefined {
  if (/\.(c|m)?(js|ts)$/i.test(candidate)) return existsSync(candidate) ? candidate : undefined
  const dir = dirname(candidate)
  return cliUnderNpmRoot(dir) ?? cliUnderNpmRoot(dirname(dir))
}

/** What the toolchain report should say about `DSH_HMOS_DEVECO_CLI`; '' when there is nothing to say. */
export function devecoCliHint(): string {
  const explicit = process.env.DSH_HMOS_DEVECO_CLI || ''
  if (!explicit) return ''
  if (!existsSync(explicit)) return ` 🔴 DSH_HMOS_DEVECO_CLI 指向的路径不存在,已忽略并回退自动探测:${explicit}`
  const traced = cliFromWrapper(explicit)
  if (traced === explicit) return ''
  if (traced) return ` DSH_HMOS_DEVECO_CLI 指向的是 npm 包装脚本(垫片),已按它的目标改用 JS 入口:${traced}`
  return ` 🔴 DSH_HMOS_DEVECO_CLI 指向的不是 devecocli 的 JS 入口(npm 包装脚本的目录下也没有 node_modules/@deveco/deveco-cli/dist/cli.js),已忽略并回退自动探测:${explicit}`
}

export function resolveDevecoCli() {
  // 1) explicit env var wins (the JS entry itself, or the npm wrapper script that points at it)
  const explicit = process.env.DSH_HMOS_DEVECO_CLI || ''
  if (explicit && existsSync(explicit)) {
    const traced = cliFromWrapper(explicit)
    if (traced) return traced
  }
  // 2) reverse-derive the npm global root from the devecocli shim on PATH
  const shim = whichFirst('devecocli')
  if (shim) {
    const traced = cliFromWrapper(shim)
    if (traced) return traced
  }
  // 3) npm root -g
  try {
    const bin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const out = spawnSync(bin, ['root', '-g'], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32' })
    if (out.status === 0) {
      const root = String(out.stdout ?? '').trim()
      const cli = cliUnderNpmRoot(root)
      if (cli) return cli
    }
  } catch {
    /* probe failed */
  }
  return undefined
}

export function resolveHdc() {
  // Binary name is platform-specific: hdc.exe on Windows, hdc on macOS/Linux.
  const suffix = process.platform === 'win32' ? 'hdc.exe' : 'hdc'
  const sdk = process.env.DEVECO_SDK_HOME || ''
  if (sdk) {
    for (const rel of [
      join('default', 'openharmony', 'toolchains', suffix),
      join('openharmony', 'toolchains', suffix),
    ]) {
      const p = join(sdk, rel)
      if (existsSync(p)) return p
    }
  }
  const found = whichFirst('hdc')
  if (found && existsSync(found)) return found
  return undefined
}

// ── Cancellation ────────────────────────────────────────────────────────

/** What a cancelled run reports instead of output. */
const CANCELLED = '(已取消)'

/**
 * The error a cancelled call ends with. Core routes on the code, never on the message, and
 * `ABORTED` is what it uses for its own aborted tool calls.
 */
export function abortedError(): Error {
  return Object.assign(new Error('tool call aborted'), { code: 'ABORTED' })
}

/** Pre-flight for a long call: refuse to start work the caller already cancelled. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortedError()
}

// ── Child process execution ─────────────────────────────────────────────

/**
 * Run one local command; resolves { code, timedOut, aborted, output }.
 * - spawn-level failures (EPERM/ENOENT) surface as readable output with code null;
 * - on timeout the process is killed and timedOut is set (cold boot / long builds);
 * - `signal` (a tool's `exec.signal`, or the route's response-close controller) kills the child the
 *   same way, terminating then escalating to SIGKILL after `graceMs`: a build that ignores the
 *   polite signal would keep holding the device. An already-aborted signal never spawns anything.
 */
export function runCli(argv: string[], { cwd, timeoutMs = 120000, signal, graceMs = 2000 }: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; graceMs?: number } = {}): Promise<{ code: number | null; timedOut: boolean; aborted: boolean; output: string }> {
  if (signal?.aborted) return Promise.resolve({ code: null, timedOut: false, aborted: true, output: CANCELLED })
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ code: null, timedOut: false, aborted: false, output: `无法启动进程:${error instanceof Error ? error.message : String(error)}` })
      return
    }
    let out = ''
    const append = (chunk) => {
      out += chunk
      if (out.length > OUTPUT_TAIL) out = out.slice(out.length - OUTPUT_TAIL)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    let settled = false
    let timedOut = false
    let aborted = false
    let escalate: ReturnType<typeof setTimeout> | null = null
    const kill = (why: 'timeout' | 'abort') => {
      if (why === 'timeout') timedOut = true
      else aborted = true
      try { child.kill() } catch { /* ignore */ }
      escalate = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, graceMs)
      // Never let the escalation timer hold the host open after the child is gone.
      ;(escalate as any)?.unref?.()
    }
    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    const onAbort = () => { if (!settled) kill('abort') }
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = () => {
      clearTimeout(timer)
      if (escalate !== null) clearTimeout(escalate)
      signal?.removeEventListener('abort', onAbort)
    }
    child.on('error', (error) => {
      if (settled) return
      settled = true
      finish()
      resolvePromise({ code: null, timedOut, aborted, output: `进程启动失败(${error.message});` + (out ? `\n${out}` : '') })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      finish()
      const tail = out.trim()
      resolvePromise({ code, timedOut, aborted, output: tail.length === 0 ? (aborted ? CANCELLED : '(无输出)') : tail })
    })
  })
}

/**
 * Stream a command: onChunk per output chunk (live deploy log). No full buffer is kept,
 * which suits long tasks.
 */
export function runCliStream(argv: string[], { cwd, timeoutMs = 120000, onChunk, signal, graceMs = 2000 }: { cwd?: string; timeoutMs?: number; onChunk?: (chunk: string) => void; signal?: AbortSignal; graceMs?: number } = {}): Promise<{ code: number | null; timedOut: boolean; aborted: boolean }> {
  if (signal?.aborted) return Promise.resolve({ code: null, timedOut: false, aborted: true })
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      onChunk?.(`无法启动进程:${error instanceof Error ? error.message : String(error)}\n`)
      resolvePromise({ code: null, timedOut: false, aborted: false })
      return
    }
    let settled = false
    let timedOut = false
    let aborted = false
    let escalate: ReturnType<typeof setTimeout> | null = null
    const kill = (why: 'timeout' | 'abort') => {
      if (why === 'timeout') timedOut = true
      else aborted = true
      try { child.kill() } catch { /* ignore */ }
      escalate = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, graceMs)
      ;(escalate as any)?.unref?.()
    }
    const timer = setTimeout(() => kill('timeout'), timeoutMs)
    const onAbort = () => { if (!settled) kill('abort') }
    signal?.addEventListener('abort', onAbort, { once: true })
    const finish = () => {
      clearTimeout(timer)
      if (escalate !== null) clearTimeout(escalate)
      signal?.removeEventListener('abort', onAbort)
    }
    child.stdout?.on('data', (chunk) => onChunk?.(String(chunk)))
    child.stderr?.on('data', (chunk) => onChunk?.(String(chunk)))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      finish()
      onChunk?.(`进程启动失败(${error.message})\n`)
      resolvePromise({ code: null, timedOut, aborted })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      finish()
      resolvePromise({ code, timedOut, aborted })
    })
  })
}

// ── Local filesystem (project picker) ───────────────────────────────────

/** Parse a devecocli --format json array; [] on failure. */
export function parseJsonArray(output) {
  try {
    const arr = JSON.parse(output)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/**
 * Pre-check that the instance's system image is registered as downloaded by devecocli.
 * On a miss it throws code=image-missing with the exact repair command, instead of
 * surfacing devecocli's raw "cannot be found, download it again". When the query fails or
 * the instance is unknown the check is skipped and start reports its own error.
 */
export async function ensureImageReady(cli, name, signal?: AbortSignal) {
  throwIfAborted(signal)
  const list = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 30000, signal })
  const inst = list.code === 0 ? parseJsonArray(list.output).find((it) => it && it.name === name) : undefined
  const os = inst && typeof inst.osVersion === 'string' ? inst.osVersion : ''
  if (!os) return
  const dt = inst && typeof inst.deviceType === 'string' && inst.deviceType ? inst.deviceType : 'phone'
  const imgs = await runCli([process.execPath, cli, 'emulator', 'image', 'list', '--all', '--format', 'json'], { timeoutMs: 60000, signal })
  if (imgs.code !== 0) return
  const ready = parseJsonArray(imgs.output).some((it) => it
    && it.osVersion === os
    && String(it.downloaded).toLowerCase() === 'true'
    && String(it.deviceType || '').toLowerCase() === dt.toLowerCase())
  if (ready) return
  throw Object.assign(
    new Error(`模拟器「${name}」的系统镜像 ${os} 未下载(或未被 devecocli 识别)。请先执行:\n  devecocli emulator image download --device-type ${dt} --os-version "${os}"\n下载完成后再启动。`),
    { code: 'image-missing' },
  )
}

/**
 * Poll the instance serial and the device list until the device is online or the timeout
 * hits. Returns { ready, serial }; serial is reported as soon as it becomes known.
 */
export async function waitDeviceReady(cli, name, { timeoutMs = 120000, intervalMs = 3000, signal }: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {}) {
  const deadline = Date.now() + timeoutMs
  let serial = null
  while (Date.now() < deadline) {
    // A cancelled start must not keep polling until the deadline (one interval of latency at most).
    if (signal?.aborted) return { ready: false, serial: null, aborted: true }
    const probe = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 15000, signal })
    if (probe.code === 0) {
      const inst = parseJsonArray(probe.output).find((it) => it && it.name === name)
      const s = inst && typeof inst.serial === 'string' && inst.serial ? inst.serial : null
      if (s) {
        serial = s
        const dev = await runCli([process.execPath, cli, 'device', 'list', '--format', 'json'], { timeoutMs: 15000, signal })
        const online = dev.code === 0 && parseJsonArray(dev.output)
          .some((x) => (typeof x === 'string' ? x : (x && (x.serial || x.name))) === s)
        if (online) return { ready: true, serial: s, aborted: false }
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs))
  }
  return { ready: false, serial, aborted: false }
}

// ── API methods ─────────────────────────────────────────────────────────

/** Serial of the first running emulator (default target for emu_ui). */
export async function firstRunningSerial(cli) {
  const r = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 20000 })
  const inst = parseJsonArray(r.output).find((it) => it && typeof it.serial === 'string' && it.serial && /running/i.test(String(it.status)))
  return inst ? inst.serial : ''
}


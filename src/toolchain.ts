import { dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { stripAnsi } from './parsers/devecocli.js'
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

/**
 * The JS entry inside one installed copy of @deveco/deveco-cli.
 *
 * The package's own `bin` field is authoritative, and the layout has moved before: 1.3.0-stable
 * shipped `dist/cli.js`, 1.3.4 ships `cli.js` at the package root. Reading the manifest handles both
 * and whatever npm writes next; the two known layouts stay as a fallback for an unreadable manifest.
 */
export function cliEntryIn(pkgDir) {
  const manifest = join(pkgDir, 'package.json')
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8'))
      const bin = typeof parsed?.bin === 'string' ? parsed.bin : parsed?.bin?.devecocli
      for (const field of [bin, parsed?.main]) {
        if (typeof field !== 'string' || field === '') continue
        const candidate = join(pkgDir, field)
        if (existsSync(candidate)) return candidate
      }
    } catch { /* an unreadable manifest falls through to the known layouts */ }
  }
  for (const layout of [join('dist', 'cli.js'), 'cli.js']) {
    const candidate = join(pkgDir, layout)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** The JS/TS entry extensions this plugin can hand to node. */
const CLI_ENTRY_EXT = /\.(c|m)?(js|ts)$/i

/**
 * The entry a launcher file names by itself — no assumption about where the package lives.
 *
 * Windows: npm writes `devecocli.cmd` / `.ps1` whose text spells the target out relative to the
 * launcher (`%dp0%`, `$PSScriptRoot`). POSIX: `bin/devecocli` is a symlink to the entry. Reading that
 * first also covers layouts npm's own answers do not describe (pnpm's global dirs, a moved prefix),
 * and it needs neither the package manifest nor a directory guess.
 * @param shimPath - the launcher found on PATH.
 * @returns the entry it launches, or undefined when the file names none (never a guessed path).
 */
export function cliTargetFromShim(shimPath: string): string | undefined {
  const dir = dirname(shimPath)
  try {
    const real = realpathSync(shimPath)
    if (real !== shimPath && existsSync(real) && CLI_ENTRY_EXT.test(real)) return real
  } catch { /* not a link, or unreadable: the launcher text is the other way to know */ }
  let text = ''
  try { text = readFileSync(shimPath, 'utf8') } catch { return undefined }
  const named = text.match(/["']?([^"'\s]*@deveco[\\/]deveco-cli[\\/][^"'\s]+\.(?:c|m)?(?:js|ts))["']?/i)
  if (named === null) return undefined
  const spelled = named[1].replace(/%~?dp0%?/gi, dir).replace(/\$PSScriptRoot/gi, dir)
  const target = isAbsolute(spelled) ? spelled : resolve(dir, spelled)
  return existsSync(target) ? target : undefined
}

/** Derive the @deveco/deveco-cli node entry from an npm global root. */
export function cliUnderNpmRoot(npmRoot) {
  if (!npmRoot) return undefined
  return cliEntryIn(join(npmRoot, 'node_modules', '@deveco', 'deveco-cli'))
}

/** A released devecocli line: the npm dist-tag an upgrade follows. */
export type CliChannel = 'stable' | 'latest'

/**
 * Which channel an upgrade follows, derived from what is installed: a `-stable` build stays on the
 * vendor's stable tag, anything else follows `latest`.
 *
 * `devecocli update` cannot express this — its help reads "Update deveco-cli to latest" and it takes
 * no options — so the channel has to be pinned through npm to be selectable.
 */
export function cliChannel(installedVersion: string | null | undefined): CliChannel {
  return typeof installedVersion === 'string' && installedVersion.includes('-stable') ? 'stable' : 'latest'
}

/** The npm spec a global install/upgrade uses for one channel. */
export function cliInstallSpec(channel: CliChannel): string {
  return `@deveco/deveco-cli@${channel}`
}

/**
 * The channel an upgrade actually installs: an explicit request wins, and without one the channel
 * the installed build came from is kept.
 * @param installedVersion - what `devecocli --version` reported, if it answered at all.
 * @param requested - a channel chosen in the panel, or anything else for "follow the install".
 * @returns the channel to install from.
 */
export function cliUpdateChannel(installedVersion: string | null | undefined, requested?: unknown): CliChannel {
  return requested === 'stable' || requested === 'latest' ? requested : cliChannel(installedVersion)
}

/**
 * How a global npm install runs on this machine.
 *
 * `DSH_HMOS_NPM` points at a stand-in program run by node, mirroring how `DSH_HMOS_DEVECO_CLI`
 * stands in for the CLI: it lets a test assert the exact argv of a path that would otherwise reach
 * the registry. Windows needs the shell (`npm` is a `.cmd` there), and the spec is a single argv
 * entry, so no shell quoting can reach it.
 */
/**
 * The version a version call reports, or '' when it reports none.
 *
 * `runCli` merges stderr into the same buffer, so a tool's warnings can sit above its answer, and the
 * answer is therefore found by shape rather than by being the first line. Only a line that is a
 * version by itself counts: a looser rule would also accept the version inside a warning ("… needs
 * node 1.2.3"), which is the one outcome worth avoiding — a wrong target version the panel would
 * offer to install. A warning written without a newline can therefore hide the answer, and that
 * costs a retry, not a wrong answer.
 * @param output - the merged stdout/stderr of a version call.
 * @returns the version with any `v` prefix dropped, or '' when none could be read.
 */
export function versionFromOutput(output: unknown): string {
  for (const line of String(output).split(/\r?\n/)) {
    const match = line.trim().match(/^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)
    if (match !== null) return match[1]
  }
  return ''
}

/**
 * How an npm command runs on this machine.
 *
 * `DSH_HMOS_NPM` points at a stand-in program run by node, mirroring how `DSH_HMOS_DEVECO_CLI`
 * stands in for the CLI: it lets a test assert the exact argv of a path that would otherwise reach
 * the registry. Windows needs the shell (`npm` is a `.cmd` there), and every argument is its own
 * argv entry, so no shell quoting can reach them.
 * @param args - the npm arguments, e.g. `['install', '-g', spec]`.
 * @returns the file to spawn, and its argv.
 */
export function npmCommand(args: string[]): { file: string; args: string[] } {
  const override = process.env.DSH_HMOS_NPM || ''
  if (override !== '') return { file: process.execPath, args: [override, ...args] }
  return process.platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/c', 'npm', ...args] }
    : { file: 'npm', args }
}

/** The global install that puts one channel in place. */
export function npmInvocation(spec: string): { file: string; args: string[] } {
  return npmCommand(['install', '-g', spec])
}

/**
 * The JS entry a devecocli path stands for. `npm i -g` writes `devecocli.cmd` / `.ps1` / an
 * extension-less sh shim side by side in the global bin dir, and each is only a launcher that runs
 * the package's own entry. The launcher's own target is read first ({@link cliTargetFromShim}), and
 * only when it names none does this fall back to the package directory's manifest
 * ({@link cliEntryIn}). Node cannot spawn such a wrapper — a `.cmd` needs a shell, and going through
 * cmd.exe would re-quote the Chinese labels and regexes this plugin passes — so a wrapper is traced
 * to its target, never run.
 */
export function cliFromWrapper(candidate: string): string | undefined {
  if (CLI_ENTRY_EXT.test(candidate)) return existsSync(candidate) ? candidate : undefined
  const named = cliTargetFromShim(candidate)
  if (named !== undefined) return named
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
  return ` 🔴 DSH_HMOS_DEVECO_CLI 指向的不是 devecocli 的 JS 入口(npm 包装脚本的目录下也找不到 @deveco/deveco-cli 的入口),已忽略并回退自动探测:${explicit}`
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
export function runCli(argv: string[], { cwd, timeoutMs = 120000, signal, graceMs = 2000, headChars = 0 }: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; graceMs?: number; headChars?: number } = {}): Promise<{ code: number | null; timedOut: boolean; aborted: boolean; output: string }> {
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
    let kept = 0
    const append = (chunk) => {
      // The default keeps the TAIL, because the line that explains a failure is at the end of a build log.
      // A caller that needs the other end sets headChars: reading a device's log buffer from its first line
      // is that case, and there the lines worth keeping are the first ones.
      if (headChars > 0) {
        if (kept >= headChars) return
        out += String(chunk).slice(0, headChars - kept)
        kept = out.length
        return
      }
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
 * Whether an account is signed in, for the two places that have to say so: the panel's toolchain report and
 * a failed `sign`.
 *
 * Measured on devecocli 1.3.4: `auth status` exits 0 **whether or not** anyone is signed in — it prints
 * `Not logged in` and still reports success — so an exit-code test would call every machine signed in. The
 * answer therefore comes from its words, and a run that failed outright is reported as unknown rather than
 * as signed out.
 */
export async function authStatus(cli: string, signal?: AbortSignal): Promise<{ known: boolean; signedIn: boolean; code: number | null; output: string }> {
  const r = await runCli([process.execPath, cli, 'auth', 'status'], { timeoutMs: 60000, ...(signal ? { signal } : {}) })
  const output = stripAnsi(r.output)
  if (r.code !== 0) return { known: false, signedIn: false, code: r.code, output }
  return { known: true, signedIn: !/not logged in/i.test(output), code: r.code, output }
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

/**
 * Parse a devecocli `--format json` array out of the chatter it wraps it in; [] on failure.
 *
 * The CLI appends its own notices to most commands (measured on 1.3.4: `New version 1.3.5 available` rides
 * along after the JSON), which makes the whole output unparseable — the array therefore has to be sliced out
 * rather than parsed from the ends of the string. `api['emu.list']` has always done this; the helpers built
 * on this one did not, so a real device's instances parsed to [].
 */
export function parseJsonArray(output) {
  const text = stripAnsi(String(output ?? ''))
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const arr = JSON.parse(text.slice(start, end + 1))
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


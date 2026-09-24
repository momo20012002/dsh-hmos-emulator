/**
 * dsh-hmos-emulator — host half.
 *
 * Turns better-sidebar tab actions into real local work: toolchain discovery,
 * emulator start/stop, device listing, project browsing, build+deploy, screenshots,
 * and one compact set of model tools (emu, emu_ui, hmos_deploy, hmos_log, hmos_docs) so an
 * agent can drive the emulator, deploy, read logs and consult the DevEco docs directly.
 *
 * The client calls this module over same-origin HTTP JSON (prefix /dsh-hmos-emulator/api)
 * with the envelope { ok: true, value } / { ok: false, error: { code, message } }.
 *
 * Imports no cordis/dsh runtime package: only the ctx API and Node builtins, so it shares
 * the host runtime instance and can mount in any host context.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'

/** Minimal cordis context: only the members used here, avoiding the full DSH type graph. */
export interface Ctx {
  get(name: string): any
  effect(callback: () => any, label?: string): void
}

export const name = 'dsh-hmos-emulator'

// Do NOT declare `inject: ['webServer']` here: the loader would treat webServer as a hard
// dependency and abort the whole composition load (this once left other host plugins such as
// dsh-mneme unmounted). Registration below polls for readiness instead, which never blocks.


/** HTTP API prefix (must match client.js; globally unique). */
const API_PREFIX = '/dsh-hmos-emulator/api'
/** Allowed API methods (keeps this from becoming an arbitrary command executor). */
const METHODS = new Set([
  'toolchain', 'emu.list', 'emu.start', 'emu.stop',
  'devices', 'scan', 'project.info', 'check.lint', 'lint.notify', 'deploy', 'device.ready', 'deveco.install', 'deveco.update', 'screenshot',
])
/** Methods whose handler owns the response (streaming); they skip the JSON envelope. */
const STREAMING_METHODS = new Set(['deploy'])
/** Directories skipped by browse/scan. */
const IGNORED_DIRS = new Set([
  'node_modules', 'oh_modules', '.git', '.hvigor', '.idea', '.ohpm',
  '.preview', '.cxx', '.appanalyzer', 'build',
])
/** Marker file identifying a HarmonyOS project root. */
const PROJECT_MARK = 'build-profile.json5'
/** Retained output cap (tail only, so a huge build log cannot flood the browser). */
const OUTPUT_TAIL = 80000

// ── Toolchain discovery ─────────────────────────────────────────────────

/** Run a command and return its first non-empty line (used by where/which probes). */
function whichFirst(bare) {
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
function cliUnderNpmRoot(npmRoot) {
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

function resolveDevecoCli() {
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

function resolveHdc() {
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

// ── Child process execution ─────────────────────────────────────────────

/**
 * Run one local command; resolves { code, timedOut, output }.
 * - spawn-level failures (EPERM/ENOENT) surface as readable output with code null;
 * - on timeout the process is killed and timedOut is set (cold boot / long builds).
 */
function runCli(argv: string[], { cwd, timeoutMs = 120000 }: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; timedOut: boolean; output: string }> {
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
      resolvePromise({ code: null, timedOut: false, output: `无法启动进程:${error instanceof Error ? error.message : String(error)}` })
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
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* ignore */ }
    }, timeoutMs)
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code: null, timedOut, output: `进程启动失败(${error.message});` + (out ? `\n${out}` : '') })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const tail = out.trim()
      resolvePromise({ code, timedOut, output: tail.length === 0 ? '(无输出)' : tail })
    })
  })
}

/**
 * Stream a command: onChunk per output chunk (live deploy log). No full buffer is kept,
 * which suits long tasks.
 */
function runCliStream(argv: string[], { cwd, timeoutMs = 120000, onChunk }: { cwd?: string; timeoutMs?: number; onChunk?: (chunk: string) => void } = {}): Promise<{ code: number | null; timedOut: boolean }> {
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
      resolvePromise({ code: null, timedOut: false })
      return
    }
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* ignore */ }
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => onChunk?.(String(chunk)))
    child.stderr?.on('data', (chunk) => onChunk?.(String(chunk)))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      onChunk?.(`进程启动失败(${error.message})\n`)
      resolvePromise({ code: null, timedOut })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code, timedOut })
    })
  })
}

// ── Local filesystem (project picker) ───────────────────────────────────

/** Coerce arbitrary input to an existing absolute dir (walks up at most 6 levels). */
function normalizeDir(input) {
  let dir = input && input.trim() ? resolve(input) : homedir()
  for (let i = 0; i < 6 && !existsSync(dir); i += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return existsSync(dir) && dir !== resolve(dir, sep) ? dir : homedir()
}

function scanProjects(root, maxDepth = 3) {
  // A project root is the project. Descending would list its modules instead, because a HarmonyOS
  // module directory carries its own build-profile.json5 (in practice: scanning a project root
  // returned only "<project>/entry"), and selecting that would aim a deploy at a module directory.
  if (existsSync(join(root, PROJECT_MARK))) return [root]
  const found = []
  let queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && found.length < 60 && visited < 1200) {
    const next = []
    for (const { dir, depth } of queue) {
      visited += 1
      let names = []
      try {
        names = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of names) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
        const child = join(dir, entry.name)
        if (existsSync(join(child, PROJECT_MARK))) {
          found.push(child)
          if (found.length >= 60) break
        } else if (depth + 1 <= maxDepth) {
          next.push({ dir: child, depth: depth + 1 })
        }
      }
      if (found.length >= 60) break
    }
    queue = next
  }
  return found
}

// ── Project info (multi-module deploy) ──────────────────────────────────

/**
 * Minimal JSON5→JSON: drop comments, quote bare keys, drop trailing commas — each of the last two
 * only outside a string literal. Whole-text regexes cannot do that: `,\s*([}\]])` also reaches
 * inside a value, so {"reason": "a, }"} would silently lose its comma, and the bare-key pattern
 * would rewrite text inside a string the same way.
 */
function stripJson5(text: string): string {
  let out = ''
  let i = 0
  let quote = ''          // current string delimiter; '' when outside a string
  let keyPending = false  // a bare key may start at the next non-space character
  while (i < text.length) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === '\\') { out += text.slice(i, i + 2); i += 2; continue }
      if (ch === quote) quote = ''
      out += ch
      i += 1
      continue
    }
    if (ch === '"') { quote = ch; out += ch; i += 1; keyPending = false; continue }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (ch === '{') { keyPending = true; out += ch; i += 1; continue }
    if (ch === ',') {
      // A comma that is followed only by a closing bracket is a trailing comma.
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j += 1
      if (text[j] === '}' || text[j] === ']') { i += 1; continue }
      keyPending = true
      out += ch
      i += 1
      continue
    }
    if (keyPending && /[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < text.length && /[\w$]/.test(text[j])) j += 1
      let k = j
      while (k < text.length && /\s/.test(text[k])) k += 1
      if (text[k] === ':') { out += `"${text.slice(i, j)}"`; i = j; keyPending = false; continue }
    }
    if (!/\s/.test(ch)) keyPending = false
    out += ch
    i += 1
  }
  return out
}

/** Read entry module names from build-profile.json5 modules[].name; [] when unparsable. */
function readModules(project: string): string[] {
  const file = join(project, PROJECT_MARK)
  if (!existsSync(file)) return []
  try {
    const cfg = JSON.parse(stripJson5(readFileSync(file, 'utf8')))
    const mods = Array.isArray(cfg?.modules) ? cfg.modules : []
    return mods.map((m) => (m && typeof m.name === 'string' ? m.name : '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The project root a model tool should act on. An absolute path is taken as given; a relative one
 * is resolved against the **session workspace** — the same base screenshots use — instead of the
 * host process's cwd, which is wherever `dsh web` happened to start. A relative `projectPath` used
 * to resolve against that cwd, so a path that looked right in the conversation pointed at a
 * directory that did not exist, and the failure only surfaced later as a confusing message about
 * `modules` .
 */
function projectRootOf(input, exec): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return ''
  return resolve(sessionWorkspace(exec), raw)
}

// ── Emulator start helpers (image precheck / readiness polling) ─────────

/** Read a PNG as a data URL (panel preview); null on failure. */
function readDataUrl(file) {
  try {
    return `data:image/png;base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}

/** Parse a devecocli --format json array; [] on failure. */
function parseJsonArray(output) {
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
async function ensureImageReady(cli, name) {
  const list = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 30000 })
  const inst = list.code === 0 ? parseJsonArray(list.output).find((it) => it && it.name === name) : undefined
  const os = inst && typeof inst.osVersion === 'string' ? inst.osVersion : ''
  if (!os) return
  const dt = inst && typeof inst.deviceType === 'string' && inst.deviceType ? inst.deviceType : 'phone'
  const imgs = await runCli([process.execPath, cli, 'emulator', 'image', 'list', '--all', '--format', 'json'], { timeoutMs: 60000 })
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
async function waitDeviceReady(cli, name, timeoutMs = 120000, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs
  let serial = null
  while (Date.now() < deadline) {
    const probe = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 15000 })
    if (probe.code === 0) {
      const inst = parseJsonArray(probe.output).find((it) => it && it.name === name)
      const s = inst && typeof inst.serial === 'string' && inst.serial ? inst.serial : null
      if (s) {
        serial = s
        const dev = await runCli([process.execPath, cli, 'device', 'list', '--format', 'json'], { timeoutMs: 15000 })
        const online = dev.code === 0 && parseJsonArray(dev.output)
          .some((x) => (typeof x === 'string' ? x : (x && (x.serial || x.name))) === s)
        if (online) return { ready: true, serial: s }
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs))
  }
  return { ready: false, serial }
}

// ── API methods ─────────────────────────────────────────────────────────

// Latest code-check result. It is cached here on every check, and only handed to the model
// when the user presses "send to AI" (lint.notify) — never automatically. The queued notice also
// remembers which session asked for it: this module is shared by every session, so without that
// the first session to assemble a prompt would receive another session's result.
let lastLintNotice = ''
let lintNotice = ''
let lintNoticeSession = ''
let lintDeliveries = 0

function createApi() {
  const api: Record<string, (payload?: any, res?: any) => Promise<any>> = {}

  /**
   * The report below is session-stable (paths, versions) but costs a devecocli spawn — ~0.6 s on
   * Windows, mostly Node startup — and the panel asks for it on every open, so it is the single
   * biggest part of the wait before the panel's first paint. `refresh: true` bypasses the cache
   * (the panel's own 刷新 button, and the install/update path where the version really did change).
   */
  const TOOLCHAIN_TTL_MS = 5 * 60 * 1000
  let toolchainCache: { at: number; value: any } | null = null

  api.toolchain = async (payload?: any) => {
    if (payload?.refresh !== true && toolchainCache !== null && Date.now() - toolchainCache.at < TOOLCHAIN_TTL_MS) {
      return toolchainCache.value
    }
    // SDK root comes from the environment only: this value is reported to the panel, and hdc is
    // resolved from the same variable, so a row-config override could only report a path that
    // discovery does not actually use.
    const sdk = process.env.DEVECO_SDK_HOME || ''
    const cliPath = resolveDevecoCli()
    // Local devecocli version (shown in the panel; helps spot an outdated CLI).
    let cliVersion = null
    if (cliPath) {
      const v = await runCli([process.execPath, cliPath, '--version'], { timeoutMs: 20000 })
      if (v.code === 0) cliVersion = (v.output.trim().split(/\r?\n/)[0] || '') || null
    }
    // Give a platform-appropriate SDK path example instead of hardcoding Windows.
    const sdkExample = process.platform === 'win32'
      ? '如 C:\\Program Files\\Huawei\\DevEco Studio\\sdk'
      : '指向本机安装的 DevEco Studio SDK 目录(以实际安装为准)'
    const report = {
      platform: process.platform,
      home: homedir(),
      node: process.execPath,
      devecoCliJs: cliPath ?? null,
      devecoCliVersion: cliVersion,
      hdcExe: resolveHdc() ?? null,
      sdkHome: sdk || null,
      hint:
        devecoCliHint() +
        'devecocli 缺失时:安装 @deveco/deveco-cli 或设置环境变量 DSH_HMOS_DEVECO_CLI。' +
        `hdc 缺失时:设置 DEVECO_SDK_HOME(${sdkExample})后重启 dsh web。` +
        (process.platform === 'linux'
          ? 'Linux 模拟器来自 Command Line Tools(需 26.0.0 Release 及以上):把 DEVECO_CLI_CLT_PATH 指向其安装目录。'
          : ''),
    }
    toolchainCache = { at: Date.now(), value: report }
    return report
  }

  api['deveco.update'] = async () => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const result = await runCli([process.execPath, cli, 'update'], { timeoutMs: 240000 })
    return {
      code: result.code,
      timedOut: result.timedOut,
      output: result.output,
      note: result.code === 0 ? 'devecocli 已更新;若宿主端路径变化,建议重启 dsh web。' : '更新失败,请查看输出(可能是 npm 源/网络问题)。',
    }
  }

  api['deveco.install'] = async () => {
    // Install @deveco/deveco-cli globally (CLI only; hdc/emulator still need the DevEco SDK).
    if (process.platform === 'win32') {
      const cmd = process.env.ComSpec || 'cmd.exe'
      const result = await runCli([cmd, '/c', 'npm', 'install', '-g', '@deveco/deveco-cli'], { timeoutMs: 240000 })
      return { code: result.code, timedOut: result.timedOut, output: result.output, note: result.code === 0 ? 'devecocli 安装完成,请重启 dsh web 生效;hdc 仍需安装 DevEco Studio SDK 并设置 DEVECO_SDK_HOME。' : '安装失败,请查看输出;也可能是 npm 源/权限问题。' }
    }
    const result = await runCli(['npm', 'install', '-g', '@deveco/deveco-cli'], { timeoutMs: 240000 })
    return { code: result.code, timedOut: result.timedOut, output: result.output, note: result.code === 0 ? 'devecocli 安装完成,请重启 dsh web 生效;hdc 仍需安装 DevEco Studio SDK 并设置 DEVECO_SDK_HOME。' : '安装失败,请查看输出;也可能是 npm 源/权限问题。' }
  }

  api['emu.list'] = async () => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    // Official JSON is most stable, but some versions mix log lines around it: slice [..].
    const result = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 60000 })
    let instances = []
    let parseError = null
    if (result.code === 0) {
      const start = result.output.indexOf('[')
      const end = result.output.lastIndexOf(']')
      if (start >= 0 && end > start) {
        try {
          const arr = JSON.parse(result.output.slice(start, end + 1))
          if (Array.isArray(arr)) {
            instances = arr
              .map((item) => ({
                name: typeof item?.name === 'string' ? item.name : '',
                status: typeof item?.status === 'string' ? item.status : '',
                serial: item?.serial ?? null,
                deviceType: typeof item?.deviceType === 'string' ? item.deviceType : '',
                osVersion: typeof item?.osVersion === 'string' ? item.osVersion : '',
              }))
              .filter((it) => it.name !== '')
          }
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error)
        }
      }
    }
    return { code: result.code, timedOut: result.timedOut, instances, parseError, raw: result.output }
  }

  api['emu.start'] = async (payload) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const name = typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim() : null
    if (!name) throw Object.assign(new Error('缺少模拟器实例名(先执行“列出模拟器”查看实例名)'), { code: 'bad-request' })
    // Pre-check the system image so a miss returns the exact download command.
    await ensureImageReady(cli, name)
    const result = await runCli([process.execPath, cli, 'emulator', 'start', name], { timeoutMs: 240000 })
    if (result.code !== 0) return { code: result.code, timedOut: result.timedOut, output: result.output, ready: false, serial: null }
    // Wait for the device to come online (replaces the manual readiness button).
    const { ready, serial } = await waitDeviceReady(cli, name)
    return { code: result.code, timedOut: result.timedOut, output: result.output, ready, serial }
  }

  api['emu.stop'] = async (payload) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const target = typeof payload?.target === 'string' && payload.target.trim() ? payload.target.trim() : null
    if (!target) throw Object.assign(new Error('缺少要停止的模拟器名称或串号'), { code: 'bad-request' })
    const result = await runCli([process.execPath, cli, 'emulator', 'stop', target], { timeoutMs: 60000 })
    return { code: result.code, timedOut: result.timedOut, output: result.output }
  }

  api.devices = async () => {
    const cli = resolveDevecoCli()
    const devices = []
    let raw = ''
    let error = null
    if (cli) {
      // Enumerate through devecocli (cross-platform) instead of a hardcoded hdc path.
      const result = await runCli([process.execPath, cli, 'device', 'list', '--format', 'json'], { timeoutMs: 30000 })
      raw = result.output
      if (result.code === 0) {
        try {
          const arr = JSON.parse(result.output)
          if (Array.isArray(arr)) {
            for (const d of arr) {
              const serial = typeof d === 'string' ? d : (d && (d.serial || d.name))
              if (typeof serial === 'string' && /^[\w.:-]+$/.test(serial)) devices.push(serial)
            }
          }
        } catch (e) {
          error = `device list 解析失败:${e instanceof Error ? e.message : String(e)}`
        }
      } else {
        error = raw
      }
    } else {
      error = '未找到 devecocli(见工具链提示)'
    }
    return { devices, raw, hdcError: error, hdcExe: resolveHdc() ?? null }
  }

  api.scan = async (payload) => {
    const root = normalizeDir(payload?.root)
    const paths = scanProjects(root)
    return { root, projects: paths }
  }

  api['project.info'] = async (payload) => {
    const project = typeof payload?.projectPath === 'string' ? resolve(payload.projectPath) : ''
    if (!project || !existsSync(project)) throw Object.assign(new Error('应用工程路径不存在'), { code: 'bad-request' })
    // readModules() answers [] for a directory without the marker, so the modules alone cannot tell
    // a project root from any other folder; report that fact explicitly.
    return { isProject: existsSync(join(project, PROJECT_MARK)), modules: readModules(project) }
  }

  // DevEco Code Linter for the selected project. Four mode pairs: changed / all decide the scope
  // (uncommitted tracked files vs. the whole project), fix / fix-all add --fix to that scope.
  // A --fix run cannot report what is left (codelinter prints only what it could fix), so it is
  // always followed by a check of the same scope: the panel result is "fixed N files; recheck …".
  api['check.lint'] = async (payload) => {
    // Validate the target before probing the toolchain: these checks are pure filesystem lookups,
    // they decide a request that a missing CLI would only mask, and a request about to be rejected
    // must not spawn `npm root -g` first.
    const project = typeof payload?.projectPath === 'string' ? resolve(payload.projectPath) : ''
    if (!project || !existsSync(project)) throw Object.assign(new Error('应用工程路径不存在'), { code: 'bad-request' })
    const asked = payload?.mode
    const fixing = asked === 'fix' || asked === 'fix-all'
    // Only a --fix run rewrites files, so only it needs a HarmonyOS project root; a plain check
    // stays usable on any directory the user picked (a single module, for instance).
    if (fixing && !existsSync(join(project, PROJECT_MARK))) {
      throw Object.assign(new Error(`“${project}”不是鸿蒙工程根(缺少 ${PROJECT_MARK}),不能执行自动修复`), { code: 'bad-request' })
    }
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const full = asked === 'all' || asked === 'fix-all'
    const mode = full ? (fixing ? 'fix-all' : 'all') : (fixing ? 'fix' : 'changed')
    const scopeMode = full ? 'all' : 'changed'
    const timeoutMs = full ? 600000 : 300000
    const argv = [process.execPath, cli, 'check', 'lint', project]
    if (!full) argv.push('--incremental')
    if (fixing) argv.push('--fix')
    // Hash the sources around the run: --fix must be judged by what it rewrote in the files.
    const before = fixing ? await hashTree(project) : null
    const fixRun = await runCli(argv, { timeoutMs })
    // The reported state always comes from a plain check, never from a --fix run's own summary.
    const check = fixing ? await runCli(argv.filter((a) => a !== '--fix'), { timeoutMs }) : fixRun
    const text = check.output
    const summary = parseLintSummary(text)
    const hasProblems = summary !== null && (summary.errors > 0 || summary.warnings > 0 || summary.suggestions > 0)
    // Only an empty result of a scoped run is ambiguous, so git is consulted just for that case.
    const changedFiles = summary !== null && summary.files === 0 && !full ? await countChangedCode(project) : null
    const outcome = lintOutcome(summary, scopeMode, changedFiles)
    let stats = outcome.stats
    if (fixing) {
      let fixedFiles: number | null = null
      if (before !== null) {
        const after = await hashTree(project)
        if (after !== null) {
          fixedFiles = 0
          for (const [path, hash] of after) if (before.get(path) !== hash) fixedFiles += 1
          for (const path of before.keys()) if (!after.has(path)) fixedFiles += 1
        }
      }
      stats = `${fixStats(fixedFiles)};${outcome.stats === '未发现告警' ? '复检未发现告警' : `复检 — ${outcome.stats}`}`
    }
    const modeLabel = LINT_LABELS[mode]
    // Issue entries come before the summary line, so an excerpt keeps the head when dirty.
    const excerpt = hasProblems ? headText(text, 30) : tailText(text, 2)
    const forModel = outcome.empty ? '' : hasProblems ? headText(text, 12) : tailText(text, 1)
    const clipped = forModel.length > 1500 ? `${forModel.slice(0, 1500)}\n…(已截断;需要全部问题时再跑一次检查)` : forModel
    lastLintNotice = `[代码检查] ${modeLabel} ${project} — ${stats}${clipped ? `\n${clipped}` : ''}`
    return {
      ok: check.code === 0,
      code: check.code,
      timedOut: fixRun.timedOut || check.timedOut,
      summary,
      empty: outcome.empty,
      stats,
      text: excerpt,
    }
  }

  // Hand the cached check result to the model only when the user asks for it. The runtime
  // context provider (registered in apply) delivers it on the next prompt assembly of the session
  // that asked, and of that one only.
  api['lint.notify'] = async (payload) => {
    if (!lastLintNotice) throw Object.assign(new Error('尚未生成检查结果,请先执行代码检查'), { code: 'bad-request' })
    lintNotice = lastLintNotice
    lintNoticeSession = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
    lintDeliveries = 0
    return { sent: true, bytes: lintNotice.length }
  }

  api.deploy = async (payload, res) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const project = typeof payload?.projectPath === 'string' ? resolve(payload.projectPath) : ''
    if (!project || !existsSync(project)) throw Object.assign(new Error('应用工程路径不存在'), { code: 'bad-request' })
    if (!existsSync(join(project, PROJECT_MARK))) {
      throw Object.assign(new Error(`“${project}”不是鸿蒙工程根(缺少 ${PROJECT_MARK})`), { code: 'bad-request' })
    }
    const device = typeof payload?.device === 'string' && payload.device.trim() ? payload.device.trim() : null
    if (!device) throw Object.assign(new Error('请先“刷新设备”并选择一个模拟器设备'), { code: 'bad-request' })
    // Pre-check that the device is online (cross-platform) before a build that takes minutes.
    if (cli) {
      const probe = await runCli([process.execPath, cli, 'device', 'list', '--format', 'json'], { timeoutMs: 15000 })
      let online = false
      if (probe.code === 0) {
        try {
          const arr = JSON.parse(probe.output)
          online = Array.isArray(arr) && arr.some((d) => { const s = typeof d === 'string' ? d : (d && (d.serial || d.name)); return s === device })
        } catch { /* parse failed: skip the precheck and let run report it */ }
      }
      if (!online) {
        throw Object.assign(new Error(`设备 ${device} 当前未在线——请先点“启动”模拟器(或连接设备),再点“扫描可用”后重试`), { code: 'device-offline' })
      }
    }
    // Multi-module: choose --module (entry when present, else the first module).
    const modules = readModules(project)
    // A panel that switched project can still be holding the previous project's module name, so a
    // name this project does not have is refused instead of being handed to the build.
    if (payload?.module !== undefined && payload?.module !== null && !modules.includes(String(payload.module))) {
      throw Object.assign(new Error(`模块“${payload.module}”不属于该工程(可选:${modules.join('、') || '无'})`), { code: 'bad-request' })
    }
    const chosen = payload?.module ? String(payload.module) : modules.includes('entry') ? 'entry' : modules[0]
    const cmd = [process.execPath, cli, 'run', '--device', device]
    if (chosen) cmd.push('--module', chosen)
    const note = (code: number | null) => code === 0
      ? '构建、安装、启动完成。(hvigor 的 “No signingConfigs” 只是警告,模拟器可装未签名 debug 包)'
      : '部署失败,请查看上方输出;常见原因:签名未配置 / 设备未就绪。'
    // Streaming: push to res as the command runs (live panel log).
    // cache-control must include no-transform: DSH webServer enables gzip (compression
    // middleware), which proxies chunked text/plain through zlib without flushing, so logs
    // would only arrive at the end (non-realtime). no-transform is the standard exemption
    // that keeps the response identity and line-by-line.
    if (res && typeof res.write === 'function') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache, no-transform' })
      res.write(`[dsh-hmos-emulator] 部署 ${device}${chosen ? `(模块 ${chosen})` : ''}\n`)
      const { code } = await runCliStream(cmd, {
        cwd: project,
        timeoutMs: 20 * 60 * 1000,
        onChunk: (chunk) => { try { res.write(chunk) } catch { /* client disconnected */ } },
      })
      res.write(`\n${note(code)}\n`)
      res.write(`[HMOS_EXIT]=${code ?? -1}\n`)
      res.end()
      return
    }
    // Non-streaming path (backwards compatible / tests): buffer the whole output.
    const result = await runCli(cmd, { cwd: project, timeoutMs: 20 * 60 * 1000 })
    return { code: result.code, timedOut: result.timedOut, output: result.output, note: note(result.code) }
  }

  api['device.ready'] = async (payload) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const serial = typeof payload?.serial === 'string' && payload.serial.trim() ? payload.serial.trim() : null
    if (!serial) throw Object.assign(new Error('缺少设备串号'), { code: 'bad-request' })
    const probe = await runCli([process.execPath, cli, 'device', 'list', '--format', 'json'], { timeoutMs: 15000 })
    let devices: string[] = []
    let online = false
    if (probe.code === 0) {
      try {
        const arr = JSON.parse(probe.output)
        devices = (Array.isArray(arr) ? arr : [])
          .map((d) => (typeof d === 'string' ? d : (d && (d.serial || d.name))))
          .filter((s) => typeof s === 'string' && /^[\w.:-]+$/.test(s))
        online = devices.includes(serial)
      } catch { /* parse failed: treat as offline */ }
    }
    return { online, serial, devices }
  }

  // Screenshot through devecocli ui screenshot (official command, not hdc). Passing a full
  // PNG path makes the CLI write that exact file , so no auto-name parsing.
  api.screenshot = async (payload) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const device = typeof payload?.device === 'string' && payload.device.trim() ? payload.device.trim() : null
    if (!device) throw Object.assign(new Error('缺少目标设备串号(先“刷新设备”并选择)'), { code: 'bad-request' })
    const root = typeof payload?.root === 'string' && payload.root.trim() ? payload.root.trim() : null
    if (!root || !existsSync(root)) throw Object.assign(new Error('缺少工作区根目录(截图存放于 <根>/screenshots)'), { code: 'bad-request' })
    const dir = join(root, 'screenshots')
    try { mkdirSync(dir, { recursive: true }) } catch (error) {
      throw Object.assign(new Error(`无法创建截图目录 ${dir}:${error instanceof Error ? error.message : String(error)}`), { code: 'fs-error' })
    }
    const safe = device.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24)
    // The name records who owns the file, and that is the whole safety argument — a hand-taken
    // shot must never be deleted by the tool:
    //   auto-<reason>-…  a shot this plugin took because something just failed → pruned to SHOT_KEEP.
    //   tool-…           a shot a model tool took (`emu_ui screenshot` / `observe`) → pruned to SHOT_KEEP.
    //   hmos-shot-…      the panel's shot, i.e. the user's own → never matched by any prune.
    // A caller cannot claim `tool` over HTTP: the route strips the field, so the only way to reach
    // the two pruned prefixes is plugin code that knows it created the file.
    const auto = payload?.auto === true
    const tool = !auto && payload?.origin === 'tool'
    const label = String(payload?.label ?? 'shot').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'shot'
    const file = join(dir, auto
      ? `${AUTO_SHOT_PREFIX}${label}-${Date.now()}-${safe}.png`
      : tool
        ? `${TOOL_SHOT_PREFIX}${Date.now()}-${safe}.png`
        : `hmos-shot-${Date.now()}-${safe}.png`)
    const result = await runCli([process.execPath, cli, 'ui', 'screenshot', '--device', device, '--path', file], { timeoutMs: 60000 })
    if (result.code !== 0 || !existsSync(file)) {
      const why = result.timedOut ? '超时' : result.code === 0 ? '未生成文件' : `退出码 ${result.code}`
      throw new Error(`截图失败(${why}):\n${result.output}`)
    }
    // Why: the directory had grown to tens of megabytes with nobody cleaning it up.
    if (auto) pruneAutoShots(dir)
    else if (tool) pruneToolShots(dir)
    return { path: file, device, dataUrl: payload?.preview ? readDataUrl(file) : null }
  }

  return api
}

// ── Route wiring ────────────────────────────────────────────────────────

/** Body cap for one request: the panel only ever sends a small JSON payload. */
const MAX_BODY_BYTES = 1_000_000

function headerValue(headers: any, name: string): string | undefined {
  const value = headers?.[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host/trustedHosts authority, or undefined when unparsable. */
function parseAuthority(authority: string | undefined): URL | undefined {
  if (authority === undefined || authority === '') return undefined
  try {
    // http: is a WHATWG "special scheme": parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** localhost, IPv6 loopback, or any 127/8 IPv4 address (DSH's loopback-hostname.ts). */
function isLoopbackHostname(hostname: string): boolean {
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
export function trustRequest(req: any, trustedHosts: readonly string[] = []): boolean {
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
 * Loopback is always accepted by trustRequest and needs no entry here. When the service is absent
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

function readBody(req: any): Promise<string> {
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

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res, error) {
  const code = error && error.code ? error.code : 'internal'
  const message = error instanceof Error ? error.message : String(error)
  const status = code === 'too-large' ? 413
    : code === 'bad-request' || code === 'toolchain' || code === 'fs-error' || code === 'image-missing' ? 400
      : 500
  writeJson(res, status, { ok: false, error: { code, message } })
}

// ── Model Tools (AI-friendly: two thin wrappers, tiny resident schema) ───

/** Tool output is compact JSON (no indentation) to save tokens. */
const TOOL_OUT_SCHEMA = { type: 'object', additionalProperties: true }

/**
 * One durable image block from a value's attachment reference, or undefined when that value
 * carries no image. The ref shape is checked rather than trusted: a half-built reference must not
 * produce a block the harness cannot resolve.
 */
function imageBlockOf(image) {
  if (!image || typeof image !== 'object' || Array.isArray(image)) return undefined
  if (typeof image.attachmentId !== 'string' || typeof image.mediaType !== 'string') return undefined
  return { type: 'image', attachment: { ...image } }
}

/**
 * Render a tool value as one text block, plus an image block when the call asked for the picture
 * itself (a screenshot that is only a path costs a second `read_image` round-trip per capture).
 * The block shape is the durable one the harness projects: `{type:'image', attachment: <ref>}` —
 * the `{data, mimeType}` form is the wire shape the harness builds from it, not a tool result.
 *
 * `steps` keeps its last step's result under `last`, so an image requested inside a batch has to be
 * found there too.
 */
const toolRender = (_args, value) => {
  const blocks: any[] = [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  const block = imageBlockOf(record?.image) ?? imageBlockOf(record?.last?.image)
  if (block) blocks.push(block)
  return blocks
}

/**
 * Store a captured PNG through the harness attachment service so it can ride the same call as an
 * image block. Every failure (no attachment service, an image the deployment refuses) degrades to
 * the text-only answer: a picture is an optimization here, never the result of the call.
 */
export async function attachmentRefForImage(ctx, filePath) {
  try {
    const attachments = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
    if (!attachments || typeof attachments.saveImage !== 'function') return undefined
    const ref = await attachments.saveImage({ data: readFileSync(filePath), mediaType: 'image/png', name: basename(filePath) })
    if (!ref || typeof ref.attachmentId !== 'string') return undefined
    return {
      attachmentId: String(ref.attachmentId),
      mediaType: String(ref.mediaType || 'image/png'),
      bytes: Number(ref.bytes) || 0,
      width: Number(ref.width) || 0,
      height: Number(ref.height) || 0,
      ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
    }
  } catch {
    return undefined
  }
}

/** Keep the first n non-empty lines (issue lists put entries before the summary). */
function headText(text, n) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '')
  return lines.slice(0, n).join('\n')
}

/** Keep the last n non-empty lines (trims command output before it reaches context). */
function tailText(text, n) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '')
  return lines.slice(-n).join('\n')
}

export interface LintSummary {
  issues: number
  errors: number
  warnings: number
  suggestions: number
  files: number
}

/**
 * Uncommitted code files `--incremental` is expected to inspect, project-relative. Only tracked
 * modifications count: a new untracked .ets file is ignored by codelinter even
 * though it matches code-linter.json5 (so the docs' "new files" does not cover untracked ones).
 * Null when git cannot answer (not a repo, no git), which is the signal to run the full check
 * instead of silently under-checking.
 *
 * Paths come back relative to the REPOSITORY root while the caller works relative to the project,
 * so they are rebased; `core.quotepath=false` keeps a non-ASCII file name readable.
 *
 * Note: codelinter's "Files checked" counts files that produced a finding, not files scanned, so
 * it can never be used to tell "nothing to check" from "checked and clean" — this list is.
 */
export async function changedCodeFiles(project: string): Promise<string[] | null> {
  return (await codeStatusFiles(project))?.changed ?? null
}

/**
 * The new-but-unadded code files of a working tree. `--incremental` never inspects them — codelinter
 * works from the tracked change set — so a refactor that *adds* files reads as a clean run
 *. Reporting them is what turns "pretending to be clean" into "saying what was not looked
 * at"; the lint behaviour itself is unchanged.
 */
export async function untrackedCodeFiles(project: string): Promise<string[] | null> {
  return (await codeStatusFiles(project))?.untracked ?? null
}

/**
 * Both halves of `git status --porcelain` that linting cares about. One call for both, so the tool
 * never pays two status runs.
 */
async function codeStatusFiles(project: string): Promise<{ changed: string[]; untracked: string[] } | null> {
  const status = await runCli(['git', '-c', 'core.quotepath=false', 'status', '--porcelain', '--', '.'], { cwd: project, timeoutMs: 15000 })
  if (status.code !== 0) return null
  const top = await runCli(['git', 'rev-parse', '--show-toplevel'], { cwd: project, timeoutMs: 15000 })
  const root = top.code === 0 ? top.output.split(/\r?\n/)[0].trim().replace(/\\/g, '/').replace(/\/+$/, '') : ''
  const changed: string[] = []
  const untracked: string[] = []
  for (const line of status.output.split(/\r?\n/)) {
    // Not a fixed-offset slice: `runCli` trims the whole output, so the FIRST line arrives
    // without its leading space (slicing 3 chars then ate the first letter of the
    // path, turning `Demo/entry/A.ets` into `emo/entry/A.ets`).
    const parsed = /^\s*([A-Z?!]{1,2})\s+(.+)$/.exec(line)
    if (!parsed) continue
    const rest = parsed[2].trim()
    // A rename reads `R  old -> new`; the new path is the one that exists now.
    const raw = rest.includes(' -> ') ? rest.slice(rest.lastIndexOf(' -> ') + 4) : rest
    const path = raw.replace(/^"(.*)"$/, '$1')
    const full = root ? relativeTo(project, join(root, path)) : path
    if (!/\.(ets|ts|js)$/.test(full)) continue
    if (parsed[1].includes('?')) untracked.push(full)
    else changed.push(full)
  }
  return { changed, untracked }
}

/**
 * How a requested lint scope resolves. `changed` needs a usable change set: without one the
 * incremental run can inspect nothing and still print a clean summary, so it escalates to the full
 * check — slower, but it cannot silently miss the file the caller just edited.
 */
export function lintScope(requested: string, changed: string[] | null): { full: boolean; escalated: boolean; checkedFiles: string[] | null } {
  if (requested === 'all') return { full: true, escalated: false, checkedFiles: null }
  if (changed === null) return { full: true, escalated: true, checkedFiles: null }
  return { full: false, escalated: false, checkedFiles: changed }
}

/** How many files a `--incremental` run is expected to inspect; null when git cannot say. */
async function countChangedCode(project: string): Promise<number | null> {
  const files = await changedCodeFiles(project)
  return files === null ? null : files.length
}

/**
 * Read a code-check result the way a user would. "changed"/"fix" pass --incremental, which only
 * inspects uncommitted tracked files: with none of them the check covered nothing, and reporting that
 * as "0 errors" would be a false all-clear.
 */
export function lintOutcome(summary: LintSummary | null, mode: string, changedFiles: number | null): { empty: boolean; stats: string } {
  if (summary === null) return { empty: false, stats: '未解析到结果' }
  const scoped = mode === 'changed' || mode === 'fix'
  if (scoped && summary.files === 0) {
    if (changedFiles === 0) return { empty: true, stats: '无 Git 已跟踪改动,未检查任何文件' }
    if (typeof changedFiles === 'number') return { empty: false, stats: `未发现告警(已检查 ${changedFiles} 个改动文件)` }
    return { empty: false, stats: '未发现告警(仅检查未提交改动)' }
  }
  if (summary.errors + summary.warnings + summary.suggestions === 0) return { empty: false, stats: '未发现告警' }
  return { empty: false, stats: `错误 ${summary.errors} / 警告 ${summary.warnings} / 建议 ${summary.suggestions} / 涉及文件 ${summary.files}` }
}

/** Panel-facing names of the four check modes. */
const LINT_LABELS = { changed: '检查改动', all: '全量检查', fix: '自动修复', 'fix-all': '全量修复' }

/** Files codelinter may rewrite, and directories it never looks at. */
const LINT_EXT = /\.(ets|ts|js|json5|json)$/
const LINT_SKIP = /(^|[\\/])(node_modules|oh_modules|build|\.git|\.hvigor|\.idea|\.preview)([\\/]|$)/

/**
 * Hash every code/config file under the project. A `--fix` run reports only the issues it could
 * fix (the same directory prints 2 issues plain and "0 issues" with --fix while nothing
 * is touched), so its own summary is useless as a result. Hashing around the run is what tells us
 * how much source actually changed.
 */
async function hashTree(root: string): Promise<Map<string, string> | null> {
  const out = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (LINT_SKIP.test(full)) continue
      if (entry.isDirectory()) await walk(full)
      else if (LINT_EXT.test(entry.name)) out.set(full, createHash('sha1').update(await readFile(full)).digest('hex'))
    }
  }
  try {
    await walk(root)
    return out
  } catch {
    return null
  }
}

/** How much a fix run rewrote, which is the only result its own output can be trusted for. */
export function fixStats(fixedFiles: number | null): string {
  if (fixedFiles === null) return '已执行自动修复(无法统计改动文件)'
  if (fixedFiles === 0) return '没有可自动修复的告警,未改动任何文件'
  return `已自动修复 ${fixedFiles} 个文件`
}

/** Parse codelinter's trailing summary line. */
const LINT_SUMMARY_RE = /Issues:\s*(\d+)\s*\|\s*Errors:\s*(\d+)\s*\|\s*Warnings:\s*(\d+)\s*\|\s*Suggestions:\s*(\d+)\s*\|\s*Files checked:\s*(\d+)/
function parseLintSummary(text: string): LintSummary | null {
  const m = String(text || '').match(LINT_SUMMARY_RE)
  return m
    ? { issues: Number(m[1]), errors: Number(m[2]), warnings: Number(m[3]), suggestions: Number(m[4]), files: Number(m[5]) }
    : null
}

/** Serial of the first running emulator (default target for emu_ui). */
async function firstRunningSerial(cli) {
  const r = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 20000 })
  const inst = parseJsonArray(r.output).find((it) => it && typeof it.serial === 'string' && it.serial && /running/i.test(String(it.status)))
  return inst ? inst.serial : ''
}

/** Drop the spinner line and blank lines from a devecocli `ui layout` dump. */
function cleanLayout(text: string): string {
  return String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '' && !/Dumping layout/i.test(l)).join('\n')
}

/**
 * Cap a rendered tree by LINE count, never by characters: a character cap slices a line in half and
 * leaves a fragment that reads like a node. The note names `depth` and `filter`, both real emu_ui
 * parameters.
 */
export function capLines(lines: string[], max = 80): string[] {
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), `…(还有 ${lines.length - max} 行未显示;可用 depth 或 filter 收窄)`]
}

/**
 * One compact layout line: `Type [x1,y1,x2,y2] "text" [clickable] [scrollable] …`.
 * In practice: devecocli prints no node id in any mode (`--mode full` and
 * `--format json` included), so `emu_ui` assigns ids by position in the dump it just returned.
 */
export interface LayoutLine {
  /** Leading widget type; empty for the bare root bounds line. */
  type: string
  /** Unescaped node text; empty for nodes that carry none. */
  text: string
  /** Node rectangle, or null when the line carries no bounds. */
  bounds: [number, number, number, number] | null
  /** Node rectangle area in px, used to prefer the innermost match. */
  area: number
  clickable: boolean
  /** Leading-space count; the dump nests children two spaces deeper than their parent. */
  indent: number
  raw: string
}

export function parseLayoutLine(raw: string): LayoutLine {
  const text = raw.match(/"((?:[^"\\]|\\.)*)"/)
  let decoded = ''
  if (text) {
    try { decoded = JSON.parse(`"${text[1]}"`) } catch { decoded = text[1] }
  }
  const box = raw.match(/\[(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/)
  const bounds: [number, number, number, number] | null = box
    ? [Number(box[1]), Number(box[2]), Number(box[3]), Number(box[4])]
    : null
  // The leading widget type, e.g. `Column` in `Column [0,0,10,10] clickable`. Real dumps also
  // carry inspector suffixes (`GridItem#SwiperPage_GridItem_[…]`), so stop at the first character
  // that cannot be part of a type name rather than requiring the bounds bracket to follow.
  const head = raw.trim().match(/^([A-Za-z_][\w.]*)/)
  return {
    type: head ? head[1] : '',
    text: decoded,
    bounds,
    area: bounds ? Math.abs((bounds[2] - bounds[0]) * (bounds[3] - bounds[1])) : Number.MAX_SAFE_INTEGER,
    clickable: /\bclickable\b/.test(raw),
    indent: raw.length - raw.trimStart().length,
    raw,
  }
}

/**
 * The node whose center should be tapped for a match. In practice: a tab label
 * flush with the screen edge has its own center in the system gesture area, where the tap is
 * swallowed, while its clickable parent is one level up. So an inert match climbs to its
 * nearest clickable ancestor — unless that ancestor dwarfs the label, which makes it a
 * container (a whole clickable page) rather than the control.
 */
function tapTarget(lines: LayoutLine[], index: number): LayoutLine {
  const hit = lines[index]
  if (hit.clickable) return hit
  let depth = hit.indent
  for (let i = index - 1; i >= 0; i--) {
    if (lines[i].indent >= depth) continue
    if (lines[i].clickable) {
      // A zero-area match has no visible point of its own, so it climbs whatever it finds
      // inside; otherwise an ancestor far larger than the label is a container, not the control.
      return hit.area === 0 || lines[i].area <= hit.area * 64 ? lines[i] : hit
    }
    depth = lines[i].indent
  }
  return hit
}

/**
 * Center of a node, moved out of the screen's bottom edge when it would land there.
 * Measured on a 1320x2856 emulator: a bottom tab bar spanning y 2688..2856 answers at
 * 2716-2730 (icon) but not at 2772-2832 (label), where the tap is swallowed by the system
 * gesture area — or read as a back gesture, which navigates away instead of failing loudly.
 * The bottom ~96px (3.4%) is dead, so a center inside the outermost 5% is replaced by the
 * center of the node's upper third, which stays inside the node.
 */
function tapPoint(target: LayoutLine, screenBottom: number): { x: number; y: number } {
  const [x1, y1, x2, y2] = target.bounds
  const x = Math.round((x1 + x2) / 2)
  const y = Math.round((y1 + y2) / 2)
  return screenBottom > 0 && y > screenBottom * 0.95 ? { x, y: Math.round(y1 + (y2 - y1) / 6) } : { x, y }
}

/** One tappable candidate for a label: the matched text node and the control actually pressed. */
export interface LabelMatch {
  /** Id (dump position) of the node whose text matched. */
  id: number
  line: LayoutLine
  /** The node whose center is pressed; its own id is what a later `click {id}` would use. */
  target: LayoutLine
  targetIndex: number
  /** Whether the match was the whole node text rather than a substring of it. */
  exact: boolean
}

/**
 * Every distinct control a label can mean, best first.
 * Rank rather than take the first `includes` hit: a tap meant for a short label must not land on a
 * container whose text merely contains it. Exact text before mere containment, clickable nodes
 * before inert ones, then the smallest area so an inner node
 * wins over the outer container that holds it. Hits sharing one tap target (a label and the
 * container it climbed to) collapse into a single candidate, so the count is a control count.
 */
export function labelMatches(lines: LayoutLine[], label: string): LabelMatch[] {
  const wanted = String(label ?? '')
  if (!wanted) return []
  const hits = lines.map((_, i) => i).filter((i) => lines[i].bounds && lines[i].text.includes(wanted))
  if (!hits.length) return []
  const rank = (i: number) => (lines[i].text === wanted ? 0 : 1) * 2 + (lines[i].clickable ? 0 : 1)
  hits.sort((a, b) => rank(a) - rank(b) || lines[a].area - lines[b].area)
  const seen = new Set<number>()
  const out: LabelMatch[] = []
  for (const i of hits) {
    const target = tapTarget(lines, i)
    const targetIndex = lines.indexOf(target)
    if (seen.has(targetIndex)) continue
    seen.add(targetIndex)
    out.push({ id: i, line: lines[i], target, targetIndex, exact: lines[i].text === wanted })
  }
  return out
}

/**
 * Compact candidate list for an ambiguous match, capped so it stays cheap. Beyond `bounds`, a
 * candidate carries `at` — the outermost ancestor text that is not the candidate's own label —
 * because on a list page the repeated label is the *only* thing that identifies nothing (three
 * cards all reading "Start" differ solely by the card title above them).
 */
function candidateList(lines: LayoutLine[], matches: LabelMatch[], cap = 5) {
  return matches.slice(0, cap).map((m, index) => {
    const label = nodeLabel(lines, m.id) || nodeLabel(lines, m.targetIndex)
    const at = ancestorLabels(lines, m.targetIndex).find((text) => text !== label) ?? ''
    return { index, label, ...(at ? { at } : {}), bounds: m.target.bounds }
  })
}

// ── Layout ids and filtering ───────────────────────────────────────

/** Optional narrowing of a dump. `type` matches case-insensitively; `textRegex` is a JS regex. */
interface LayoutQuery { type?: string; textRegex?: string; clickableOnly?: boolean }

/** Lines matching the query, each paired with its dump-wide id. */
function selectLayoutLines(lines: LayoutLine[], query: LayoutQuery = {}): { index: number; line: LayoutLine }[] {
  let re: RegExp | null = null
  if (typeof query?.textRegex === 'string' && query.textRegex) {
    try { re = new RegExp(query.textRegex) } catch { re = null }
  }
  const wanted = typeof query?.type === 'string' ? query.type.toLowerCase() : ''
  const picked = lines.map((line, index) => ({ index, line })).filter(({ line }) => {
    if (wanted && line.type.toLowerCase() !== wanted) return false
    if (re && !re.test(line.text)) return false
    return true
  })
  if (!query?.clickableOnly) return picked
  // A label usually sits in an inert child while the node carrying the action is its clickable
  // parent, so `clickableOnly` reports the tap target of each match — the same node `click {id}`
  // will press. Filtering on "text AND clickable" alone would return nothing for such labels.
  const seen = new Set<number>()
  const out: { index: number; line: LayoutLine }[] = []
  for (const { index, line } of picked) {
    if (line.clickable) {
      if (!seen.has(index)) { seen.add(index); out.push({ index, line }) }
      continue
    }
    const target = tapTarget(lines, index)
    const targetIndex = target && target.clickable ? lines.indexOf(target) : -1
    if (targetIndex < 0 || seen.has(targetIndex)) continue
    seen.add(targetIndex)
    out.push({ index: targetIndex, line: lines[targetIndex] })
  }
  return out
}

/**
 * Render rows as one line per node, ids first (`#12 Column [..] clickable`) so a later `click {id}`
 * references the exact node that was read, including icon nodes with no text.
 */
function renderLines(rows: { index: number; line: LayoutLine }[]): string[] {
  return rows.map(({ index, line }) => `${' '.repeat(line.indent)}#${index} ${line.raw.trim()}`)
}

/** A rendered dump for the model, capped. */
function renderLayout(rows: { index: number; line: LayoutLine }[]): string {
  return capLines(renderLines(rows)).join('\n')
}

/**
 * The diffable identity of a set of nodes: the raw dump line, without our `#id` decoration. Ids are
 * assigned by position, so a single node appearing above would rewrite every id below it and bury
 * the one real change in noise.
 */
function rawKeys(rows: { index: number; line: LayoutLine }[]): string[] {
  return rows.map(({ line }) => line.raw.trim())
}

/**
 * Multiset difference of two rendered trees: the lines that disappeared, then the lines that
 * appeared. This exists for the shape `0 / 3` → `1 / 3`, where the whole tree is noise and the one
 * changed line is the assertion; `changed:0` is the "nothing moved" answer the caller checks for.
 */
export function diffLines(before: string[], after: string[]): string {
  const counts = new Map<string, number>()
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of after) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added.push(line)
  }
  const removed: string[] = []
  for (const [line, left] of counts) for (let i = 0; i < left; i += 1) removed.push(line)
  if (added.length === 0 && removed.length === 0) return 'changed:0'
  return [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join('\n')
}

/**
 * Human-readable name of a node: its own text, or — for a container matched through a child's
 * label (the clickable tab that owns the text) — the first text inside it. Why:
 * `filter{clickableOnly}` reports the clickable Column, which carries no text of its own.
 */
export function nodeLabel(lines: LayoutLine[], index: number): string {
  const own = lines[index] ? lines[index].text : ''
  if (own) return own
  const indent = lines[index] ? lines[index].indent : 0
  for (let i = index + 1; i < lines.length; i += 1) {
    if (lines[i].indent <= indent) break
    if (lines[i].text) return lines[i].text
  }
  return ''
}

/**
 * Text breadcrumb of a node, outermost first, capped at `limit` entries — the identity of what is
 * about to be pressed. `nodeLabel` alone cannot answer this: the three cards each end in a
 * "Start" button, and only the card title tells them apart, so each ancestor contributes its
 * own label (own text, else the first text inside it — which for a card container IS its title).
 * Empty levels are skipped and repeats collapsed, so the tail is normally the pressed control.
 */
export function ancestorLabels(lines: LayoutLine[], index: number, limit = 3): string[] {
  const chain: string[] = []
  const own = nodeLabel(lines, index)
  if (own) chain.push(own)
  const refArea = lines[index] ? lines[index].area : 0
  let indent = lines[index] ? lines[index].indent : 0
  for (let i = index - 1; i >= 0 && chain.length < limit; i -= 1) {
    if (lines[i].indent >= indent) continue
    // Same "a much larger ancestor is a container, not the label" guard tapTarget uses, and the
    // same reason: a page-level Column inherits the FIRST text under it, which on a list page is
    // another item's title — a breadcrumb must not name a sibling item as this one's parent.
    if (refArea > 0 && lines[i].area > refArea * 64) break
    indent = lines[i].indent
    const label = nodeLabel(lines, i)
    if (label && label !== chain[chain.length - 1]) chain.push(label)
  }
  return chain.reverse()
}

/**
 * Text that identifies the page currently showing, used to answer "which page am I on" after a
 * tap. Prefers the shallowest text inside a `NavDestination` subtree (the page's own header), then
 * accepts the dump's first text only when it sits at the very top and is not a bare number —
 * shape of that failure: a page whose title area holds no words produced `"0"`, a stat
 * number, which names nothing. Returns '' rather than a guess, since callers confirm navigation
 * with it.
 */
export function pageTitle(lines: LayoutLine[]): string {
  const navIndex = lines.findIndex((l) => l.type.toLowerCase() === 'navdestination')
  if (navIndex >= 0) {
    const indent = lines[navIndex].indent
    let shallowest = Number.MAX_SAFE_INTEGER
    let found = ''
    for (let i = navIndex + 1; i < lines.length; i += 1) {
      if (lines[i].indent <= indent) break
      if (lines[i].text && lines[i].indent < shallowest) { shallowest = lines[i].indent; found = lines[i].text }
    }
    if (found) return found
  }
  // Otherwise accept a top-level text only from the header band. On a typical screen the only
  // top-level texts are the statistics — a big counter and its small label, well below the header
  // — so both "first text" and "first non-numeric text" named the wrong page. A page name
  // that is wrong is worse than none, so anything lower than the band is refused and the caller
  // gets `page: null`.
  const bottom = lines.reduce((max, l) => (l.bounds ? Math.max(max, l.bounds[3]) : max), 0)
  const band = bottom * 0.2
  const first = lines.find((l) => l.text && l.bounds && l.bounds[1] < band && !/^\d+$/.test(l.text.trim()))
  return first && first.indent <= 2 ? first.text : ''
}

/** Flat JSON view. Cheaper than devecocli's nested `--format json` and it carries our ids. */
export function layoutJson(rows: { index: number; line: LayoutLine }[], lines: LayoutLine[] = []): any[] {
  return rows.map(({ index, line }) => {
    const label = lines.length > 0 ? nodeLabel(lines, index) : line.text
    return {
      id: index,
      type: line.type,
      bounds: line.bounds,
      depth: Math.floor(line.indent / 2),
      clickable: line.clickable,
      ...(line.text ? { text: line.text } : {}),
      // An inherited label (the text lives in a child) is what tells the caller what it matched.
      ...(label && label !== line.text ? { label } : {}),
    }
  })
}

/** Tap point of a stored node, so a later `click {id}` lands where the dump said it was. */
function pointOf(lines: LayoutLine[], index: number): { x: number; y: number } | null {
  const line = lines[index]
  if (!line || !line.bounds) return null
  const screenBottom = Math.max(...lines.map((l) => (l.bounds ? l.bounds[3] : 0)))
  return tapPoint(tapTarget(lines, index), screenBottom)
}

/** Nodes matching a text/regex query, with their ids and tap points (used by waitFor). */
function matchLayout(lines: LayoutLine[], { text, textRegex, clickableOnly }: { text?: string; textRegex?: string; clickableOnly?: boolean } = {}) {
  const wanted = typeof text === 'string' ? text : ''
  let re: RegExp | null = null
  if (typeof textRegex === 'string' && textRegex) {
    try { re = new RegExp(textRegex) } catch { re = null }
  }
  if (!wanted && !re) return []
  const hits: { id: number; x: number; y: number; text: string }[] = []
  lines.forEach((line, index) => {
    if (!line.bounds) return
    if (clickableOnly && !line.clickable) return
    const hit = (wanted && line.text.includes(wanted)) || (re ? re.test(line.text) : false)
    if (!hit) return
    const point = pointOf(lines, index)
    if (point) hits.push({ id: index, x: point.x, y: point.y, text: line.text })
  })
  return hits
}

// ── Structured parsers ────

/** One codelinter finding, from the report table. */
export interface LintFinding { file: string; line: number; column: number; severity: string; rule: string; message: string }

/**
 * Parse codelinter's report table. Shape of a full run: rows are space-padded
 * (`No  File  Line  Column  Severity  Rule  Message`) and the File column is relative to the
 * process cwd — so the check must be run with `cwd: project` for project-relative paths.
 * The Message column is last, so any spacing inside it survives.
 */
export function parseLintTable(text: string): { findings: LintFinding[]; summary: LintSummary | null } {
  const findings: LintFinding[] = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d+)\s{2,}(.+?)\s{2,}(\d+)\s{2,}(\d+)\s{2,}(Error|Warning|Suggestion)\s{2,}(\S+)\s{2,}(.*)$/)
    if (!m) continue
    findings.push({ file: m[2].trim(), line: Number(m[3]), column: Number(m[4]), severity: m[5], rule: m[6], message: m[7].trim() })
  }
  return { findings, summary: parseLintSummary(text) }
}

/** One ArkTS compiler error from a failed build. */
export interface BuildError { file: string; line: number; column: number; code: string; message: string }

/**
 * Parse the ArkTS error blocks hvigor prints on a failed build. Shape of a failure:
 *   1 ERROR: 10505001 ArkTS Compiler Error
 *   Error Message: Expression expected. At File: C:/…/PanelBody.ets:185:34
 *   COMPILE RESULT:FAIL {ERROR:2 WARN:27}
 * The rollup variant spells its tail "At file:" lower-case on the next line, hence the tolerant
 * tail; the severity counts come from the COMPILE RESULT line when it is present.
 */
export function parseBuildErrors(text: string): { errors: BuildError[]; errorCount: number; warnCount: number } {
  const src = String(text || '')
  const errors: BuildError[] = []
  const re = /\d+\s+ERROR:\s*(\d+)?\s*[^\n]*\nError Message:\s*([\s\S]*?)\s*At [Ff]ile:\s*([^\n]*?):(\d+)(?::(\d+))?/g
  let m
  while ((m = re.exec(src)) !== null) {
    errors.push({
      file: m[3].trim(),
      line: Number(m[4]),
      column: m[5] ? Number(m[5]) : 0,
      code: (m[1] || '').trim(),
      message: m[2].replace(/\s+/g, ' ').trim(),
    })
  }
  const counts = src.match(/COMPILE RESULT:\w*\s*\{ERROR:(\d+)\s+WARN:(\d+)\}/)
  return { errors, errorCount: counts ? Number(counts[1]) : errors.length, warnCount: counts ? Number(counts[2]) : 0 }
}

/** Strip the project root from a report path, so a finding reads like the lint File column does. */
function relativeTo(root: string, file: string): string {
  const norm = (s: string) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const f = norm(file)
  return r && f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f
}

/**
 * Furthest deploy stage the output reached, from the stage markers `devecocli run` prints:
 *   `[hvigor build] Running...`      → `Build completed successfully.`
 *   `Installing artifacts to device` → `App installed successfully`
 *   `Launching <bundle>/<ability>...` → `start ability successfully.`
 * A failed run stops at the stage that failed, so the last marker seen is that stage.
 */
export function deployPhase(text: string): 'build' | 'install' | 'launch' {
  const src = String(text || '')
  if (/Launching\s+\S+/.test(src)) return 'launch'
  if (/Installing artifacts/.test(src)) return 'install'
  return 'build'
}

/** Newest hap under the module's standard hvigor output directory (standard layout). */
function hapPathOf(project: string, module: string): string | null {
  const dir = join(project, module, 'build', 'default', 'outputs', 'default')
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.hap'))
    let best = ''
    let bestMs = -1
    for (const f of files) {
      const ms = statSync(join(dir, f)).mtimeMs
      if (ms > bestMs) { bestMs = ms; best = f }
    }
    return best ? join(dir, best) : null
  } catch {
    return null
  }
}

/** One hilog line, split into the fields a developer filters by. */
export interface LogLine { time: string; level: string; tag: string; message: string }

/**
 * Parse hilog lines. Line format:
 *   `09-13 21:49:14.737 10388 10388 W C02c02/PARAM: SystemReadParam failed!…`
 * `tag` is the part after the domain slash (`PARAM`), which is the name callers know.
 * Lines that do not match (devecocli's progress line, wrapped continuations) are dropped.
 */
export function parseLogLines(text: string): LogLine[] {
  const out: LogLine[] = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([DIWEF])\s+(\S+?):\s?(.*)$/)
    if (!m) continue
    const domainTag = m[5]
    out.push({
      time: m[1],
      level: m[4],
      tag: domainTag.includes('/') ? domainTag.slice(domainTag.lastIndexOf('/') + 1) : domainTag,
      message: m[6].trim(),
    })
  }
  return out
}

/**
 * One line describing a step result. A batch answers with summaries plus the last step in full:
 * the point of `steps` is fewer round trips, so a step-by-step copy of every payload would undo it.
 */
export function stepSummary(action: string, value: any): string {
  if (value === null || typeof value !== 'object') return String(value ?? '')
  if (value.ok !== true) return String(value.error ?? value.reason ?? '失败').replace(/\s+/g, ' ').slice(0, 160)
  const bits: string[] = []
  if (value.page) bits.push(`page=${value.page}`)
  if (Number.isFinite(value.total)) bits.push(`${value.total} 节点`)
  if (Array.isArray(value.ancestors) && value.ancestors.length > 0) bits.push(value.ancestors.join('/'))
  if (Number.isFinite(value.matchCount) && value.matchCount > 1) bits.push(`match=${value.matchCount}`)
  if (Number.isFinite(value.x)) bits.push(`(${value.x},${value.y})`)
  if (Array.isArray(value.matched)) bits.push(`matched=${value.matched.length}`)
  if (typeof value.tree === 'string' && value.tree) bits.push(value.tree.replace(/\s*\n\s*/g, ' | ').slice(0, 160))
  return bits.join(' ') || `${action} ok`
}

/**
 * The session workspace: the calling agent's session cwd, read off the tool-call context
 * (`exec.agent.session.header.cwd` — the durable absolute cwd the host recorded for the session).
 * Agentless calls (tests, bare dispatch) fall back to `process.cwd()`. This is where screenshots
 * belong: a path outside it is a path the agent cannot read back.
 */
export function sessionWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : process.cwd()
}

/** Prefix of every screenshot this plugin writes on its own initiative. */
export const AUTO_SHOT_PREFIX = 'auto-'
/**
 * Prefix of the captures the **model tools** write on their own initiative (`emu_ui screenshot`).
 * They are named apart from `hmos-shot-*` for one reason: only a file the plugin knows it created
 * may ever be pruned. The user's own shots go through the panel and keep the `hmos-shot-*` name, so
 * "never auto-delete a hand-taken shot" is enforced by the name, not by a heuristic.
 */
export const TOOL_SHOT_PREFIX = 'tool-'

/**
 * How many captures of one owned prefix are kept — both pruned prefixes share this number.
 *
 * A capture is a full-screen PNG (1320x2856, ~2.4 MB on this emulator), so the count *is* the disk
 * bound: 40 ≈ 96 MB per prefix, ~192 MB for the two together. A fixed count is what keeps the
 * directory from growing without bound.
 *
 * One capture costs ~1.6 s, so a burst of 20 screenshots (~35 s) would evict a deliberate shot taken
 * a minute earlier; 40 keeps a usable window. Raising it costs only disk, because a delivered image
 * is already durable in the attachment store — the PNG here is the original, not the record.
 */
export const SHOT_KEEP = 40

/** Keep only the newest `keep` files carrying one prefix; returns how many were removed. */
function pruneByPrefix(dir: string, prefix: string, keep: number): number {
  try {
    const shots = readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.png'))
      .map((f) => ({ f, ms: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.ms - a.ms)
    let removed = 0
    for (const { f } of shots.slice(keep)) {
      try { unlinkSync(join(dir, f)); removed += 1 } catch { /* keep the rest */ }
    }
    return removed
  } catch {
    return 0
  }
}

/**
 * Keep only the newest `keep` automatic screenshots. Automatic shots exist for the failure that
 * just happened, so they are disposable — but only `auto-*` is ever deleted: the directory is
 * shared with hand-taken shots, and a tool that prunes user files is worse than a full disk.
 */
export function pruneAutoShots(dir: string, keep = SHOT_KEEP): number {
  return pruneByPrefix(dir, AUTO_SHOT_PREFIX, keep)
}

/**
 * Keep only the newest `keep` captures the model tools took. Safe for the same reason
 * `pruneAutoShots` is: the prefix proves the plugin wrote the file (`hmos-shot-*`, the panel's and
 * the user's, is never matched here).
 */
export function pruneToolShots(dir: string, keep = SHOT_KEEP): number {
  return pruneByPrefix(dir, TOOL_SHOT_PREFIX, keep)
}

/**
 * Take a screenshot because something just failed — the next question after "the tap did nothing"
 * is always "what did it look like". Only the path is returned by default: the image would cost
 * context, and for locating a node the tree is more precise than a scaled 1320x2856 PNG.
 *
 * `read` attaches the picture as well. The attachment store normalizes and downscales before the
 * request (`attachment-local`), the same path `screenshot {read:true}` uses. Failures here are
 * swallowed on purpose: a
 * screenshot that cannot be taken must not turn one failure into two.
 */
async function autoShot(api, device: string, root: string, label: string): Promise<string> {
  try {
    const value = await api.screenshot({ device, root, auto: true, label })
    return typeof value?.path === 'string' ? value.path : ''
  } catch {
    return ''
  }
}

/** The failure-shot fields to spread into a result: the path, plus the image when one was asked for. */
async function shotFields(api, device: string, root: string, label: string, ctx, read: boolean) {
  const path = await autoShot(api, device, root, label)
  if (!path) return {}
  const image = read ? await attachmentRefForImage(ctx, path) : undefined
  return image ? { shot: path, image } : { shot: path }
}

/**
 * One slice of a long document, with the numbers a caller needs to page through it. Returns the
 * whole text when it already fits, and `nextOffset` only when there is more to read.
 */
export function sliceText(text: string, offset = 0, limit = 8000): { text: string; total: number; offset: number; nextOffset: number | null } {
  const full = String(text ?? '')
  const start = Math.max(0, Math.floor(offset) || 0)
  const size = Math.max(1, Math.floor(limit) || 0)
  const body = full.slice(start, start + size)
  const nextOffset = start + size < full.length ? start + size : null
  return { text: body, total: full.length, offset: start, nextOffset }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** One decoded PNG: 8-bit RGB(A) pixels, row-major, unfiltered. */
export interface DecodedPng { width: number; height: number; channels: number; pixels: Buffer }

/** Paeth predictor, straight from the PNG spec. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Decode a PNG far enough to compare pixels. `devecocli ui screenshot` writes one shape —
 * 1320x2856, 8 bit, colorType 6 (RGBA), interlace 0, filter 0 — and Node's zlib does the inflate, so
 * this stays dependency-free. Anything outside that shape is refused by name rather than guessed at.
 */
export function decodePng(file: Buffer): DecodedPng {
  const data = Buffer.isBuffer(file) ? file : Buffer.from(file)
  if (data.length < 8 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('不是 PNG(签名不符)')
  let offset = 8
  let header: { width: number; height: number; depth: number; color: number; interlace: number } | null = null
  const idat: Buffer[] = []
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset)
    const type = data.subarray(offset + 4, offset + 8).toString('ascii')
    const chunk = data.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      header = { width: chunk.readUInt32BE(0), height: chunk.readUInt32BE(4), depth: chunk[8], color: chunk[9], interlace: chunk[12] }
    } else if (type === 'IDAT') idat.push(chunk)
    else if (type === 'IEND') break
  }
  if (!header) throw new Error('PNG 缺少 IHDR')
  if (header.depth !== 8) throw new Error(`PNG 位深 ${header.depth} 不支持(只处理 8 位)`)
  if (header.interlace !== 0) throw new Error('PNG 是隔行(interlace)编码,不支持')
  const channels = header.color === 6 ? 4 : header.color === 2 ? 3 : 0
  if (channels === 0) throw new Error(`PNG 颜色类型 ${header.color} 不支持(只处理 RGB/RGBA)`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = header.width * channels
  if (raw.length < header.height * (stride + 1)) throw new Error('PNG 数据不完整')
  const pixels = Buffer.alloc(header.height * stride)
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1)
    const start = y * stride
    const above = start - stride
    for (let i = 0; i < stride; i += 1) {
      const byte = line[i]
      const left = i >= channels ? pixels[start + i - channels] : 0
      const up = y > 0 ? pixels[above + i] : 0
      const upLeft = y > 0 && i >= channels ? pixels[above + i - channels] : 0
      const value = filter === 0 ? byte
        : filter === 1 ? byte + left
          : filter === 2 ? byte + up
            : filter === 3 ? byte + ((left + up) >> 1)
              : filter === 4 ? byte + paeth(left, up, upLeft)
                : NaN
      if (Number.isNaN(value)) throw new Error(`PNG 行过滤类型 ${filter} 不支持`)
      pixels[start + i] = value & 0xff
    }
  }
  return { width: header.width, height: header.height, channels, pixels }
}

/** CRC32 table for PNG chunks, built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** One PNG chunk: length, type, body, CRC over type+body. */
function pngChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

/**
 * Encode 8-bit RGB/RGBA pixels as a PNG, filter 0 on every row. The mirror of `decodePng`, and the
 * The one thing a region capture needs: devecocli has no crop option, so a region capture means cutting the
 * bitmap locally — which needs a way to write it back out. Deflate comes from `node:zlib`, so this
 * stays dependency-free like the decoder.
 */
export function encodePng(image: DecodedPng): Buffer {
  const { width, height, channels, pixels } = image
  if (channels !== 3 && channels !== 4) throw new Error(`无法编码 ${channels} 通道(只处理 RGB/RGBA)`)
  if (width <= 0 || height <= 0) throw new Error(`无法编码 ${width}x${height} 的图`)
  const stride = width * channels
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = channels === 4 ? 6 : 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Cut a rectangle out of a decoded PNG, clamped to the image bounds. Returns the rectangle actually
 * used (`clamped: true` when it differs from the request), so a partly off-screen request is
 * reported rather than silently producing a different picture.
 */
export function cropPng(image: DecodedPng, rect: { x: number; y: number; w: number; h: number }): { image: DecodedPng; rect: { x: number; y: number; w: number; h: number }; clamped: boolean } {
  const asked = { x: Math.floor(rect.x), y: Math.floor(rect.y), w: Math.floor(rect.w), h: Math.floor(rect.h) }
  const x = Math.max(0, Math.min(image.width - 1, asked.x))
  const y = Math.max(0, Math.min(image.height - 1, asked.y))
  const w = Math.max(1, Math.min(image.width - x, asked.w))
  const h = Math.max(1, Math.min(image.height - y, asked.h))
  const clamped = x !== asked.x || y !== asked.y || w !== asked.w || h !== asked.h
  const stride = image.width * image.channels
  const rowBytes = w * image.channels
  const out = Buffer.alloc(h * rowBytes)
  for (let row = 0; row < h; row += 1) {
    const from = (y + row) * stride + x * image.channels
    image.pixels.copy(out, row * rowBytes, from, from + rowBytes)
  }
  return { image: { width: w, height: h, channels: image.channels, pixels: out }, rect: { x, y, w, h }, clamped }
}

/**
 * Pixel difference between two captures, as the fraction of pixels whose channels differ at all.
 * Two captures of an unchanged screen are byte-identical , so callers get `same` from a
 * byte compare and never reach this function on the cheap path; it exists for the other case, where
 * "did that colour change actually land on screen, and how much" has to be a number rather than a
 * 268 KB image read into context.
 */
export function diffPng(before: DecodedPng, after: DecodedPng, tolerance = 0): { same: boolean; diffRatio: number; changedPixels: number; totalPixels: number } {
  const total = before.width * before.height
  if (before.width !== after.width || before.height !== after.height || before.channels !== after.channels) {
    return { same: false, diffRatio: 1, changedPixels: total, totalPixels: total }
  }
  let changed = 0
  for (let i = 0; i < before.pixels.length; i += before.channels) {
    for (let c = 0; c < before.channels; c += 1) {
      if (Math.abs(before.pixels[i + c] - after.pixels[i + c]) > tolerance) { changed += 1; break }
    }
  }
  return { same: changed === 0, diffRatio: Number((changed / total).toFixed(6)), changedPixels: changed, totalPixels: total }
}

/**
 * Two model tools:
 *  - emu    : instance list/start/stop (reuses image precheck + readiness polling)
 *  - emu_ui : inspect/drive the screen through devecocli ui (compact layout tree, label click)
 */
function createToolDefs(api, ctx = null) {
  /** Last dump per device, so `click {id}` resolves the node the caller just read. */
  const lastLayout = new Map<string, LayoutLine[]>()
  /**
   * The two baselines behind `changedOnly` and `waitForChange`. They live HERE, beside `lastLayout`,
   * and not inside `execute`: a map declared in the tool body is rebuilt on every call, so a
   * baseline from the previous call is never seen.
   */
  const lastRender = new Map<string, string[]>()
  const lastDump = new Map<string, string[]>()
  /**
   * Last screenshot taken per device, so a compare call can name it as `"last"`. The clip rect is
   * remembered with it: a cropped capture cannot serve as a whole-screen baseline, and treating it
   * as one answered "everything changed" (`diffRatio: 1`) instead of saying the sizes differ.
   */
  const lastShot = new Map<string, { path: string; clip?: { x: number; y: number; w: number; h: number } }>()
  const emu = {
    name: 'emu',
    description: 'List/start/stop emulators via devecocli (start waits until online).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'start', 'stop'], description: 'list | start (waits online) | stop' },
        name: { type: 'string', description: 'instance name (start/stop)' },
      },
      required: ['action'],
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args) {
      const cli = resolveDevecoCli()
      if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
      const action = String(args?.action || '')
      if (action === 'list') {
        const r = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 30000 })
        const instances = parseJsonArray(r.output).map((it) => ({ name: it.name, status: it.status, serial: it.serial ?? null, osVersion: it.osVersion }))
        return { ok: r.code === 0, instances, error: r.code === 0 ? '' : tailText(r.output, 5) }
      }
      const name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : ''
      if (!name) return { ok: false, error: 'name is required for start/stop' }
      if (action === 'start') {
        try { await ensureImageReady(cli, name) } catch (error) { return { ok: false, stage: 'image', error: error instanceof Error ? error.message : String(error) } }
        const r = await runCli([process.execPath, cli, 'emulator', 'start', name], { timeoutMs: 240000 })
        if (r.code !== 0) return { ok: false, stage: 'start', code: r.code, error: tailText(r.output, 8) }
        const { ready, serial } = await waitDeviceReady(cli, name)
        return { ok: true, ready, serial }
      }
      if (action === 'stop') {
        const r = await runCli([process.execPath, cli, 'emulator', 'stop', name], { timeoutMs: 60000 })
        return { ok: r.code === 0, code: r.code, error: r.code === 0 ? '' : tailText(r.output, 5) }
      }
      return { ok: false, error: `unknown action ${action}` }
    },
  }

  /** Speed (px/s) for a drag that did not ask for one: devecocli synthesizes the gesture from it. */
  const DRAG_SPEED = 400

  const emuUi = {
    name: 'emu_ui',
    description: 'Drive the emulator screen via devecocli ui. layout: tree lines (#id Type [x1,y1,x2,y2] "text" flags) + page title (window/allWindows reach system and UIExtension windows); click/longPress/doubleTap by label, id or x/y (results carry an ancestors breadcrumb, and matchCount/candidates when a label is ambiguous); waitFor/waitForChange/waitForIdle instead of sleeping; steps batches actions; drag/fling/dircfling/swipe/text/screenshot. Screenshots are static frames only; pinch/zoom (multi-finger) is unsupported.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['layout', 'observe', 'click', 'text', 'swipe', 'screenshot', 'waitFor', 'waitForChange', 'waitForIdle', 'longPress', 'doubleTap', 'drag', 'fling', 'dircfling', 'steps'], description: 'UI action' },
        steps: { type: 'array', items: { type: 'object' }, description: 'steps: [{action,...}] in order (see onFail)' },
        onFail: { type: 'string', enum: ['stop', 'continue'], description: 'steps: stop (default, returns stoppedAt) | continue (runs all, returns failedAt)' },
        changedOnly: { type: 'boolean', description: 'layout/thenLayout: only changed lines vs the previous render' },
        device: { type: 'string', description: 'serial (default: first running)' },
        id: { type: 'integer', description: 'press: node id from the last layout' },
        label: { type: 'string', description: 'press: node text; exact first, else smallest clickable ancestor' },
        labelIndex: { type: 'integer', description: 'press: candidate index when label repeats (see matchCount)' },
        depth: { type: 'integer', description: 'layout/waitFor: depth (0=unlimited, 1=root)' },
        filter: { type: 'object', description: 'layout/thenLayout: node filter', properties: { type: { type: 'string' }, textRegex: { type: 'string' }, clickableOnly: { type: 'boolean' } } },
        full: { type: 'boolean', description: 'layout: include unlabeled/inert nodes (--mode full)' },
        asJson: { type: 'boolean', description: 'layout: flat JSON nodes (label: inherited text)' },
        window: { type: 'integer', description: 'layout: window id from `devecocli ui window list`' },
        allWindows: { type: 'boolean', description: 'layout: every window incl. system/UIExtension ones (--all-windows; for pickers, permission dialogs)' },
        textRegex: { type: 'string', description: 'waitFor: JS regex on node text' },
        clickableOnly: { type: 'boolean', description: 'waitFor: clickable only' },
        absent: { type: 'boolean', description: 'waitFor: succeed when the match is gone instead of present' },
        timeoutMs: { type: 'integer', description: 'wait: total ms (5000); one dump (1.5-3s) cannot be interrupted, so elapsed may exceed it by one dump' },
        pollMs: { type: 'integer', description: 'wait: poll ms (200)' },
        stablePolls: { type: 'integer', description: 'waitForIdle: stable dumps (2)' },
        thenLayout: { type: 'boolean', description: 'click: layout after the tap (honours filter/changedOnly)' },
        thenWaitFor: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            textRegex: { type: 'string' },
            absent: { type: 'boolean' },
            timeoutMs: { type: 'integer' },
            pollMs: { type: 'integer' },
          },
          additionalProperties: true,
          description: 'click: wait for this condition after the tap, then dump (same shape as waitFor; replaces the fixed waitMs guess)',
        },
        waitMs: { type: 'integer', description: 'thenLayout ms (600, max 5000); thenWaitFor timeout floor' },
        x: { type: 'integer', description: 'press/swipe/drag: start x' },
        y: { type: 'integer', description: 'press/swipe/drag: start y' },
        x2: { type: 'integer', description: 'swipe/drag: end x' },
        y2: { type: 'integer', description: 'swipe/drag: end y' },
        velocity: { type: 'integer', description: 'drag/swipe/fling: px/s; drag defaults to 400 (a speedless drag can be a silent no-op)' },
        direction: { type: 'string', description: 'dircfling: left|right|up|down' },
        text: { type: 'string', description: 'text: string to type, or the waitFor match' },
        root: { type: 'string', description: 'screenshot: dir for the PNG (default: workspace)' },
        baseline: { type: 'string', description: 'screenshot: PNG path or "last" to compare' },
        read: { type: 'boolean', description: 'attach the image; a failed click/wait also attaches its shot' },
        keep: { type: 'boolean', description: 'screenshot: keep the PNG on disk (default true); false deletes it once the image is attached; ignored with baseline' },
        clip: {
          type: 'object',
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' } },
          required: ['x', 'y', 'w', 'h'],
          additionalProperties: false,
          description: 'screenshot/observe: crop to this device-pixel rect (layout coordinates) so the preview stays 1:1; not with baseline',
        },
        log: {
          type: 'object',
          properties: {
            level: { type: 'string' },
            keyword: { type: 'string' },
            tail: { type: 'integer' },
            crash: { type: 'boolean' },
          },
          additionalProperties: true,
          description: 'observe: also return device logs in the same call (hmos_log parameters)',
        },
      },
      required: ['action'],
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args, exec) {
      const cli = resolveDevecoCli()
      if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
      const device = (typeof args?.device === 'string' && args.device.trim() ? args.device.trim() : '') || await firstRunningSerial(cli)
      if (!device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' }
      const run = (argv, timeoutMs) => runCli([process.execPath, cli, ...argv], { timeoutMs })
      const depth = Number.isFinite(args?.depth) ? Math.max(0, Math.floor(args.depth)) : 0
      /**
       * The depth one call should dump at. A `steps` entry carries its own arguments ("same
       * parameters as a normal call" is what `steps` promises), so a per-step `depth` has to reach
       * `--depth`.
       */
      const depthOf = (step: any) => (Number.isFinite(step?.depth) ? Math.max(0, Math.floor(step.depth)) : depth)
      /** Where screenshots go: the session workspace, so the path it hands back can be read again. */
      const shotRoot = sessionWorkspace(exec)

      /** devecocli takes integer screen coordinates; a node centre lands on .5, so round on the way out. */
      const px = (n: number) => String(Math.round(Number(n)))

      /**
       * A step's own window selection wins, otherwise the call's — the same rule `depth` follows.
       * Returned as a scope object because the caller also needs it to report the depth override
       * `allWindows` forces.
       */
      const windowScope = (step?: Record<string, unknown>) => ({
        win: Number.isFinite(step?.window) ? Number(step?.window) : (Number.isFinite(args?.window) ? Number(args.window) : undefined),
        every: typeof step?.allWindows === 'boolean' ? step.allWindows : args?.allWindows === true,
      })

      /**
       * Dump the tree and remember it. A dump taken right after a navigation can come back with
       * only the progress line, so retry briefly before believing it. `full` switches devecocli to `--mode full`, the only mode that keeps
       * unlabeled and inert containers (much longer than the default mode for the same screen) — the
       * default prunes the very node that can be swallowing a tap.
       */
      const dumpLayout = async (full = false, atDepth = depth, step?: Record<string, unknown>): Promise<{ ok: boolean; lines: LayoutLine[]; error?: string }> => {
        const { win, every } = windowScope(step)
        // Any positive depth answers with the window roots alone, whose subtrees are empty — which
        // reads as "this screen has nothing on it". All windows means the content, so depth is 0.
        const at = every ? 0 : atDepth
        const argv = ['ui', 'layout', '--device', device, '--depth', String(at)]
        if (full) argv.push('--mode', 'full')
        // Other windows (system pickers, permission dialogs, UIExtension panels) are simply absent
        // from a focused-window dump; `--all-windows` is the only way to see them at all.
        if (every) argv.push('--all-windows')
        else if (win !== undefined) argv.push('--window', String(Math.floor(win)))
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const r = await run(argv, 30000)
          if (r.code !== 0) return { ok: false, lines: [], error: tailText(r.output, 6) }
          const lines = cleanLayout(r.output).split(/\r?\n/).map(parseLayoutLine).filter((l) => l.bounds)
          if (lines.length > 0) {
            lastLayout.set(device, lines)
            lastDump.set(device, lines.map((l) => l.raw.trim()))
            return { ok: true, lines }
          }
          if (attempt < 2) await new Promise((resolveWait) => setTimeout(resolveWait, 400))
        }
        return { ok: true, lines: [] }
      }

      /** Render rows, remembering what the caller saw so the next `changedOnly` has a baseline. */
      const renderFor = (rows: { index: number; line: LayoutLine }[], changedOnly: boolean): string => {
        const keys = rawKeys(rows)
        // A filter that matched nothing is NOT "nothing changed": answer `matched:0`, never an empty
        // tree or `changed:0`.
        if (keys.length === 0) return 'matched:0'
        const previous = lastRender.get(device)
        lastRender.set(device, keys)
        // The first call has nothing to compare against, so answering with a wall of `+` lines would
        // only hide the tree the caller asked for; a diff needs two renders by definition.
        return changedOnly && previous ? diffLines(previous, keys) : capLines(renderLines(rows)).join('\n')
      }

      /**
       * One action. A function rather than an inline chain, because `steps` runs exactly the same
       * code for each element — a batch must not be a second, subtly different implementation.
       * `a` is the step object when called from `steps`, the tool arguments otherwise.
       */
      const perform = async (a: any): Promise<any> => {
        const action = String(a?.action || '')
        if (action === 'steps') {
          const list = Array.isArray(a?.steps) ? a.steps : []
          if (list.length === 0) return { ok: false, error: 'steps 需要一个非空的 steps 数组(元素与普通调用同参)。' }
          const keepGoing = a?.onFail === 'continue'
          const done: any[] = []
          let last: any = null
          let stoppedAt = -1
          const failedAt: number[] = []
          for (let i = 0; i < list.length; i += 1) {
            const step = list[i] && typeof list[i] === 'object' ? list[i] : {}
            const stepAction = String(step.action || '')
            const at = Date.now()
            if (!stepAction || stepAction === 'steps') {
              last = { ok: false, error: stepAction === 'steps' ? 'steps 不能嵌套(每一步都必须是一个具体动作)' : '每一步都需要 action' }
            } else {
              try {
                last = await perform(step)
              } catch (error) {
                last = { ok: false, error: error instanceof Error ? error.message : String(error) }
              }
            }
            done.push({ action: stepAction || '?', ok: last?.ok === true, ms: Date.now() - at, summary: stepSummary(stepAction, last) })
            if (last?.ok !== true) {
              failedAt.push(i)
              if (!keepGoing) { stoppedAt = i; break }
            }
          }
          // `ok` reflects the batch, not the last step: a failure in the middle is still a failure.
          const failed = failedAt.length > 0
          return {
            ok: !failed,
            device,
            steps: done,
            last,
            // `stoppedAt` means the batch really stopped there — only `stop` can do that. A `continue`
            // batch ran every step, so it reports the failing indices instead of a stop position that
            // never happened.
            ...(stoppedAt >= 0 ? { stoppedAt } : {}),
            ...(keepGoing && failed ? { failedAt } : {}),
          }
        }
        if (action === 'layout') {
          const at = depthOf(a)
          const dump = await dumpLayout(a?.full === true, at, a)
          if (!dump.ok) return { ok: false, device, error: dump.error }
          const rows = selectLayoutLines(dump.lines, a?.filter)
          const page = pageTitle(dump.lines)
          // `depth` and `full` are measured differently — `--mode full` keeps the
          // `window`/`root` containers, so the same number denotes a shallower slice of the real
          // page. A caller that asked for a shallow full dump gets containers only and could read
          // that as "the page is empty"; say what happened instead of guessing a corrected depth.
          const textless = at > 0 && !dump.lines.some((line) => line.text)
          const overrode = windowScope(a).every && at > 0
          const note = overrode
            ? `allWindows 已按 depth:0 执行:depth=${at} 时 devecocli 只回窗口根、子树全空(容易被读成"这屏什么都没有");看到的这棵树是全部窗口的完整内容。`
            : textless
              ? `这次 dump 只有容器、没有任何文字:depth=${at} 只到第 ${at} 层${a?.full === true ? '(full 模式还会多出 window/root 两层)' : ''};要看内容请用 depth:0 或不传 depth。`
              : undefined
          return a?.asJson
            ? { ok: true, device, total: dump.lines.length, page: page || null, ...(note ? { note } : {}), nodes: layoutJson(rows, dump.lines) }
            : { ok: true, device, total: dump.lines.length, page: page || null, ...(note ? { note } : {}), tree: renderFor(rows, a?.changedOnly === true) }
        }
        if (action === 'click' || action === 'longPress' || action === 'doubleTap') {
          // All three are "point at a node and press it": only the devecocli verb differs.
          const verb = action === 'click' ? 'click' : action === 'longPress' ? 'longclick' : 'doubleclick'
          let point = null
          let usedId = null
          let ancestors: string[] = []
          let page = ''
          let matchCount = 0
          let pickedIndex = 0
          let candidates = null
          let inexact = false
          if (Number.isFinite(a?.x) && Number.isFinite(a?.y)) {
            point = { x: a.x, y: a.y }
          } else if (Number.isFinite(a?.id)) {
            // Ids come from the most recent layout, so no re-dump: the caller clicks what it read.
            const stored = lastLayout.get(device)
            if (!stored) return { ok: false, device, error: '尚无 layout 记录:id 来自最近一次 layout,请先调用 layout' }
            const found = pointOf(stored, Number(a.id))
            if (!found) return { ok: false, device, error: `id ${a.id} 在最近一次 layout 中不存在或没有坐标` }
            point = found
            usedId = Number(a.id)
            ancestors = ancestorLabels(stored, usedId)
            page = pageTitle(stored)
          } else if (typeof a?.label === 'string' && a.label.trim()) {
            // Resolve a label to its center in one call: avoids a layout round-trip before click.
            const dump = await dumpLayout()
            if (!dump.ok) return { ok: false, device, error: dump.error }
            const matches = labelMatches(dump.lines, a.label)
            if (!matches.length) {
              // A label that resolves to nothing is usually an overlay or a half-drawn page, which
              // is exactly the case where a picture answers what the tree cannot.
              const shot = await shotFields(api, device, shotRoot, 'click', ctx, a?.read === true)
              return { ok: false, device, error: `no layout node matching "${a.label}"`, page: pageTitle(dump.lines) || null, ...shot }
            }
            const want = Number.isFinite(a?.labelIndex) ? Math.max(0, Math.floor(a.labelIndex)) : 0
            matchCount = matches.length
            pickedIndex = want
            // Repeated labels are the norm on list pages. Answer with the whole candidate set instead
            // of pressing the first one: an unnoticed wrong press costs far more than these bytes.
            if (matchCount > 1) candidates = candidateList(dump.lines, matches)
            if (want >= matchCount) {
              return { ok: false, device, error: `"${a.label}" 匹配 ${matchCount} 个候选,labelIndex ${want} 越界(0..${matchCount - 1})`, matchCount, candidates }
            }
            const match = matches[want]
            point = pointOf(dump.lines, match.targetIndex)
            if (!point) return { ok: false, device, error: `匹配到的节点没有可用坐标:${match.target.raw.trim()}` }
            ancestors = ancestorLabels(dump.lines, match.targetIndex)
            page = pageTitle(dump.lines)
            inexact = !match.exact
          } else return { ok: false, error: `${action} needs id, label or x/y` }
          const r = await run(['ui', verb, px(point.x), px(point.y), '--device', device], 20000)
          if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 4) }
          const result: any = { ok: true, device, x: Math.round(point.x), y: Math.round(point.y) }
          if (usedId !== null) result.id = usedId
          // `page` is always present, `null` when the tree carries no title — "no title" and
          // "the field is missing" looked the same to a caller, and only one of them is a signal.
          result.page = page || null
          // The breadcrumb replaces the old raw `matched`/`tapped` lines: `Row [928,2702,…] clickable`
          // only repeated the coordinates we already return, while the text of the ancestors is what
          // tells the caller which of several identical buttons it just pressed.
          if (ancestors.length) result.ancestors = ancestors
          if (matchCount > 1) { result.matchCount = matchCount; result.pickedIndex = pickedIndex; result.candidates = candidates }
          // A containment-only match tapped a node whose text merely held the label; say so,
          // so the caller can re-issue with exact x/y when that is not the intended node.
          if (inexact) result.matchedBy = 'contains'
          // thenLayout verifies the tap in the same call. `thenWaitFor` waits for a condition instead
          // of the fixed settle delay: a guess of 600 ms is either wasted or too short, and the
          // caller would otherwise spend its next round on the `waitFor` it already knows about.
          if (action === 'click' && (a?.thenLayout || a?.thenWaitFor)) {
            const condition = a?.thenWaitFor && typeof a.thenWaitFor === 'object' ? a.thenWaitFor : null
            if (condition) {
              const waited = await perform({
                ...condition,
                action: 'waitFor',
                timeoutMs: Number.isFinite(condition.timeoutMs) ? condition.timeoutMs : (Number.isFinite(a?.waitMs) ? a.waitMs : 5000),
                ...(Number.isFinite(condition.pollMs) ? { pollMs: condition.pollMs } : {}),
              })
              result.thenWaitFor = {
                ok: waited?.ok === true,
                elapsedMs: waited?.elapsedMs,
                ...(condition.absent === true ? { absent: true } : { matched: Array.isArray(waited?.matched) ? waited.matched.length : 0 }),
                ...(waited?.ok === true ? {} : { error: waited?.error ?? '等待条件未在超时内成立' }),
              }
            } else {
              const wait = Number.isFinite(a?.waitMs) ? Math.max(0, Math.min(5000, a.waitMs)) : 600
              if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait))
            }
            const after = await dumpLayout(false, depthOf(a))
            result.tree = after.ok
              ? renderFor(selectLayoutLines(after.lines, a?.filter), a?.changedOnly === true)
              : after.error
          }
          return result
        }
        if (action === 'text') {
          const value = typeof a?.text === 'string' ? a.text : ''
          if (!value) return { ok: false, error: 'text is required' }
          // `--` ends option parsing: without it a string starting with "-" is read as an option
          // ("--help" prints help and exits 0, which the tool would have reported as success).
          const r = await run(['ui', 'text', '--device', device, '--', value], 20000)
          return { ok: r.code === 0, device, error: r.code === 0 ? '' : tailText(r.output, 4) }
        }
        if (action === 'swipe') {
          if (![a?.x, a?.y, a?.x2, a?.y2].every((n) => Number.isFinite(n))) return { ok: false, error: 'swipe needs x, y, x2, y2' }
          const argv = ['ui', 'swipe', px(a.x), px(a.y), px(a.x2), px(a.y2), '--device', device]
          // devecocli's swipe takes a speed like drag/fling does; without it a slow, threshold-y
          // swipe cannot be reproduced at all.
          if (Number.isFinite(a?.velocity)) argv.push('--speed', String(Math.max(1, Math.floor(a.velocity))))
          const r = await run(argv, 20000)
          return { ok: r.code === 0, device, error: r.code === 0 ? '' : tailText(r.output, 4) }
        }
        if (action === 'screenshot') {
          const asked = typeof a?.root === 'string' && a.root.trim() ? a.root.trim() : shotRoot
          const wanted = typeof a?.baseline === 'string' ? a.baseline.trim() : ''
          const read = a?.read === true
          // devecocli cannot crop, so a region capture is cut here. Doing it before the
          // attachment is what makes the preview ~1:1 — the whole point of the option.
          const clipWanted = a?.clip && typeof a.clip === 'object' ? a.clip : null
          if (clipWanted && wanted) {
            return { ok: false, device, error: 'clip 与 baseline 互斥:基线比对的是一整屏,裁剪会让"变没变"的坐标语义变模糊。' }
          }
          if (clipWanted && ![clipWanted.x, clipWanted.y, clipWanted.w, clipWanted.h].every((n) => Number.isFinite(n))) {
            return { ok: false, device, error: 'clip 需要 {x, y, w, h}(设备像素,与 layout 的 [x1,y1,x2,y2] 同一坐标系)。' }
          }
          // `screenshots/` grew without bound because every `read:true` capture stayed
          // on disk after it had been delivered. `keep:false` deletes it again — the picture is in the
          // conversation, and a baseline comparison is the one case that still needs the file.
          const discard = a?.keep === false && !wanted && read
          // `origin` marks this file as one the tool wrote, so it may be pruned later; the panel
          // never sends it and its files therefore keep the never-pruned `hmos-shot-*` name.
          const value = await api.screenshot({ device, root: asked, origin: 'tool' })
          const rel = relativeTo(asked, value.path)
          let clipped = null
          if (clipWanted) {
            try {
              const region = cropPng(decodePng(readFileSync(value.path)), { x: clipWanted.x, y: clipWanted.y, w: clipWanted.w, h: clipWanted.h })
              writeFileSync(value.path, encodePng(region.image))
              clipped = {
                ...region.rect,
                ...(region.clamped ? { clamped: true, requested: { x: clipWanted.x, y: clipWanted.y, w: clipWanted.w, h: clipWanted.h } } : {}),
              }
            } catch (error) {
              return { ok: false, device, path: value.path, error: `裁剪失败:${error instanceof Error ? error.message : String(error)}` }
            }
          }
          if (!wanted) {
            // No baseline asked for: this shot is what a later call compares against.
            if (!discard) {
              lastShot.set(device, {
                path: value.path,
                ...(clipped ? { clip: { x: clipped.x, y: clipped.y, w: clipped.w, h: clipped.h } } : {}),
              })
            }
            // Absolute path for `read_image`, workspace-relative one for talking about it.
            const image = read ? await attachmentRefForImage(ctx, value.path) : undefined
            let gone = false
            // deleting without having delivered the picture leaves the caller with nothing.
            if (discard && image) {
              try { unlinkSync(value.path); gone = true } catch { /* a leftover file is harmless */ }
            }
            return {
              ok: true, ...(gone ? {} : { path: value.path }), ...(gone || rel === value.path ? {} : { rel }), device: value.device,
              ...(clipped ? { clip: clipped } : {}),
              ...(gone ? { discarded: true } : {}),
              ...(image ? { image } : {}),
              ...(read && !image ? { imageUnavailable: '附件服务不可用或该图超出部署限制,只回了路径' } : {}),
              ...(a?.keep === false && read && !gone ? { keepFailed: '图已留在盘上(附件没能生成,删了就没图可看)。' } : {}),
            }
          }
          const previous = wanted === 'last' ? lastShot.get(device) : undefined
          const baselinePath = wanted === 'last' ? previous?.path ?? '' : wanted
          /**
           * A refused comparison still has a real capture on disk, and it is the picture the caller
           * most wants next ("your baseline is a crop — so show me the screen"). Naming it costs
           * nothing and turns 2.4 MB of orphaned file into a usable path, exactly as the success
           * path does; without it the file was left behind unmentioned (found in the 2026-09-19
           * verification: an unreferenced capture). It is a `tool-*` file, so a
           * refused comparison can no longer be the thing that slowly fills the directory.
           */
          const capture = { diffPath: value.path, ...(rel !== value.path ? { rel } : {}) }
          if (!baselinePath) return { ok: false, device, error: '还没有基线:先不带 baseline 调一次 screenshot,或直接传 PNG 路径。', ...capture }
          // A crop is not a whole-screen baseline: comparing the two gave `diffRatio: 1` (the size
          // guard read "different dimensions" as "everything changed"), which looks like a real
          // answer. Say what happened instead.
          if (previous?.clip) {
            const { x, y, w, h } = previous.clip
            return {
              ok: false, device,
              error: `上一次截图是裁剪图(${x},${y},${w},${h}),不能当整屏基线;请先用不带 clip 的 screenshot 建立整屏基线,或直接传整屏 PNG 路径。`,
              ...capture,
            }
          }
          if (!existsSync(baselinePath)) return { ok: false, device, error: `基线文件不存在:${baselinePath}`, ...capture }
          const before = readFileSync(baselinePath)
          const after = readFileSync(value.path)
          // Unchanged screens are byte-identical, so the common case costs no decode at all.
          if (before.equals(after)) {
            // Nothing moved: drop the capture instead of keeping a second copy of the same screen.
            try { unlinkSync(value.path) } catch { /* a leftover duplicate is harmless */ }
            return { ok: true, device, same: true, diffRatio: 0 }
          }
          let verdict
          try {
            verdict = diffPng(decodePng(before), decodePng(after))
          } catch (error) {
            return { ok: false, device, error: `无法比对基线:${error instanceof Error ? error.message : String(error)}`, diffPath: value.path }
          }
          if (verdict.same) {
            try { unlinkSync(value.path) } catch { /* ignore */ }
            return { ok: true, device, same: true, diffRatio: 0 }
          }
          // It moved, so the new capture is worth looking at — the same `read` flag covers it.
          const movedImage = read ? await attachmentRefForImage(ctx, value.path) : undefined
          return {
            ok: true, device, same: false, diffRatio: verdict.diffRatio, changedPixels: verdict.changedPixels,
            // `diffRatio` without its denominator is hard to sanity-check; hand the total over too.
            totalPixels: verdict.totalPixels,
            diffPath: value.path, ...(rel !== value.path ? { rel } : {}),
            ...(movedImage ? { image: movedImage } : {}),
            ...(read && !movedImage ? { imageUnavailable: '附件服务不可用或该图超出部署限制,只回了路径' } : {}),
          }
        }
        if (action === 'drag' || action === 'fling') {
          if (![a?.x, a?.y, a?.x2, a?.y2].every((n) => Number.isFinite(n))) return { ok: false, error: `${action} needs x, y, x2, y2` }
          const argv = ['ui', action, px(a.x), px(a.y), px(a.x2), px(a.y2), '--device', device]
          // devecocli synthesizes the gesture from the speed: a speedless drag moves nothing and
          // still reports success, so a drag that did not ask for one gets a working default.
          const speed = Number.isFinite(a?.velocity) ? Math.max(1, Math.floor(a.velocity)) : (action === 'drag' ? DRAG_SPEED : null)
          if (speed !== null) argv.push('--speed', String(speed))
          const r = await run(argv, 20000)
          return { ok: r.code === 0, device, error: r.code === 0 ? '' : tailText(r.output, 4) }
        }
        if (action === 'dircfling') {
          // The accepted direction words are devecocli's business, so pass the value through.
          const dir = typeof a?.direction === 'string' ? a.direction.trim() : ''
          if (!dir) return { ok: false, error: 'dircfling needs direction' }
          const r = await run(['ui', 'dircfling', dir, '--device', device], 20000)
          return { ok: r.code === 0, device, error: r.code === 0 ? '' : tailText(r.output, 4) }
        }
        if (action === 'waitFor') {
          // Replaces the sleep-then-poll loop: the poll interval is the tool's business now.
          const timeout = Number.isFinite(a?.timeoutMs) ? Math.max(0, Math.min(60000, a.timeoutMs)) : 5000
          const poll = Number.isFinite(a?.pollMs) ? Math.max(50, Math.min(2000, a.pollMs)) : 200
          // `absent` waits for the match to be GONE — the only way to observe a drawer, dialog,
          // keyboard or toast closing, which `waitForChange`/`waitForIdle` can only approximate.
          const absent = a?.absent === true
          const started = Date.now()
          let last: LayoutLine[] = []
          for (;;) {
            const dump = await dumpLayout()
            if (!dump.ok) return { ok: false, device, error: dump.error }
            last = dump.lines
            const hits = matchLayout(last, {
              text: typeof a?.text === 'string' ? a.text : '',
              textRegex: a?.textRegex,
              clickableOnly: a?.clickableOnly,
            })
            if (absent ? hits.length === 0 : hits.length > 0) {
              // The dump that matched is already in memory, so the tree costs nothing and saves the
              // round-trip this action exists to avoid: "wait for X, then tap it" was two calls
              // because only the timeout branch answered with a tree (the ids in it are the ones
              // `click {id}` resolves against, since `dumpLayout` just refreshed `lastLayout`).
              const found = pageTitle(last)
              return {
                ok: true, device, elapsedMs: Date.now() - started,
                ...(absent ? { absent: true, matched: [] } : { matched: hits }),
                page: found || null,
                tree: renderLayout(last.map((line, index) => ({ index, line }))),
              }
            }
            if (Date.now() - started + poll > timeout) break
            await new Promise((resolveWait) => setTimeout(resolveWait, poll))
          }
          // A timeout hands back the tree it last saw (and a picture of it), so a miss is diagnosable
          // without another call. For `absent` the miss is the opposite one: the match is still there.
          const page = pageTitle(last)
          const shot = await shotFields(api, device, shotRoot, action, ctx, a?.read === true)
          const late = absent
            ? matchLayout(last, { text: typeof a?.text === 'string' ? a.text : '', textRegex: a?.textRegex, clickableOnly: a?.clickableOnly })
            : []
          return { ok: false, device, matched: late, elapsedMs: Date.now() - started, ...(absent ? { absent: true } : {}), page: page || null, ...shot, tree: renderLayout(last.map((line, index) => ({ index, line }))) }
        }
        if (action === 'waitForChange') {
          // The counterpart of waitForIdle: that one returns as soon as the layout is stable, which
          // is exactly wrong when a tap was swallowed by an overlay and nothing ever moves.
          const timeout = Number.isFinite(a?.timeoutMs) ? Math.max(0, Math.min(60000, a.timeoutMs)) : 5000
          const poll = Number.isFinite(a?.pollMs) ? Math.max(50, Math.min(2000, a.pollMs)) : 300
          const started = Date.now()
          // The baseline is the LAST DUMP, not a snapshot taken now: `click {label}` dumps to resolve
          // the label, so by the time this action starts the transition it is asked to observe may
          // already have happened — which is precisely the miss this action exists to prevent.
          let baseline = lastDump.get(device)
          if (!baseline) {
            const first = await dumpLayout()
            if (!first.ok) return { ok: false, device, error: first.error }
            baseline = first.lines.map((l) => l.raw.trim())
          }
          let polls = 0
          let last: LayoutLine[] = lastLayout.get(device) ?? []
          for (;;) {
            const dump = await dumpLayout()
            if (!dump.ok) return { ok: false, device, error: dump.error }
            polls += 1
            last = dump.lines
            const moved = diffLines(baseline, dump.lines.map((l) => l.raw.trim()))
            if (moved !== 'changed:0') {
              return { ok: true, device, polls, elapsedMs: Date.now() - started, changed: capLines(moved.split('\n')).join('\n') }
            }
            if (Date.now() - started + poll > timeout) break
            await new Promise((resolveWait) => setTimeout(resolveWait, poll))
          }
          const page = pageTitle(last)
          const shot = await shotFields(api, device, shotRoot, action, ctx, a?.read === true)
          return { ok: false, device, polls, elapsedMs: Date.now() - started, page: page || null, ...shot, tree: renderLayout(last.map((line, index) => ({ index, line }))) }
        }
        if (action === 'waitForIdle') {
          const timeout = Number.isFinite(a?.timeoutMs) ? Math.max(0, Math.min(60000, a.timeoutMs)) : 5000
          const poll = Number.isFinite(a?.pollMs) ? Math.max(50, Math.min(2000, a.pollMs)) : 300
          const need = Number.isFinite(a?.stablePolls) ? Math.max(2, Math.min(10, Math.floor(a.stablePolls))) : 2
          const started = Date.now()
          let previous = ''
          let stable = 0
          let polls = 0
          let last: LayoutLine[] = []
          for (;;) {
            const dump = await dumpLayout()
            if (!dump.ok) return { ok: false, device, error: dump.error }
            last = dump.lines
            polls += 1
            const now = dump.lines.map((l) => l.raw).join('\n')
            stable = now !== '' && now === previous ? stable + 1 : 1
            previous = now
            if (stable >= need) {
              // Same reason as `waitFor`: the stable dump is already here, and the tree it renders
              // is what the caller is about to act on — answering without it cost a `layout` round.
              const settled = pageTitle(last)
              return {
                ok: true, device, polls, elapsedMs: Date.now() - started,
                page: settled || null,
                tree: renderLayout(last.map((line, index) => ({ index, line }))),
              }
            }
            if (Date.now() - started + poll > timeout) break
            await new Promise((resolveWait) => setTimeout(resolveWait, poll))
          }
          const idlePage = pageTitle(last)
          const idleShot = await shotFields(api, device, shotRoot, action, ctx, a?.read === true)
          return { ok: false, device, polls, elapsedMs: Date.now() - started, page: idlePage || null, ...idleShot, tree: renderLayout(last.map((line, index) => ({ index, line }))) }
        }
        if (action === 'observe') {
          // "What is on screen right now" in one call: the tree the caller needs in order to decide,
          // plus — with `read` — the picture that answers what the tree cannot (blank page, layout
          // bug). Composing layout with screenshot keeps exactly one implementation of each, and the
          // tree still arrives when the capture fails.
          const seen = await perform({ ...a, action: 'layout' })
          if (seen?.ok !== true) return seen
          const extra: any = {}
          // debugging an odd screen was `act → observe → hmos_log`; the log that always comes
          // next can ride along, through the same implementation `hmos_log` uses.
          if (a?.log && typeof a.log === 'object') {
            const logs = await hmosLog.execute({ ...a.log, ...(device ? { device } : {}) }, exec)
            extra.log = logs?.ok === true
              ? { count: logs.count, lines: logs.lines }
              : { error: logs?.error ?? '日志读取失败' }
          }
          if (a?.read !== true) return { ...seen, ...extra }
          const shot = await perform({ ...a, action: 'screenshot' })
          if (shot?.ok === true) return { ...seen, ...extra, ...shot, ok: true }
          return { ...seen, ...extra, shotError: shot?.error ?? '截图失败' }
        }
        return { ok: false, error: `unknown action ${action}` }
      }

      return perform(args)
    },
  }

  const hmosDeploy = {
    name: 'hmos_deploy',
    description: 'Build and deploy a project via devecocli (run: build -> install -> launch; buildOnly: build only). Returns phase, duration, ArkTS errors with file/line, hap path and an output tail.',
    parameters: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'project root (contains build-profile.json5)' },
        device: { type: 'string', description: 'serial (default: first running emulator)' },
        module: { type: 'string', description: 'module (default: entry)' },
        buildOnly: { type: 'boolean', description: 'build only: no device, no install/launch' },
        skipBuild: { type: 'boolean', description: 'run --skip-build: install + launch existing artifacts' },
        read: { type: 'boolean', description: 'attach the failure screenshot when the deploy fails, not just its path' },
      },
      required: ['projectPath'],
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args, exec) {
      const cli = resolveDevecoCli()
      if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
      const projectPath = projectRootOf(args?.projectPath, exec)
      if (!projectPath) return { ok: false, error: 'projectPath is required' }
      // Name the directory that was actually searched. Without this, a relative path that resolved
      // somewhere else surfaced later as `模块"entry"不属于该工程(可选:无)` — an error about modules
      // for what was really a missing `build-profile.json5`.
      if (!existsSync(join(projectPath, PROJECT_MARK))) {
        return { ok: false, error: `未找到 ${PROJECT_MARK}:已按 ${projectPath} 查找(传目录时请给工程根,相对路径按会话工作区解析)。` }
      }
      const buildOnly = args?.buildOnly === true
      const skipBuild = args?.skipBuild === true
      const device = buildOnly
        ? ''
        : (typeof args?.device === 'string' && args.device.trim() ? args.device.trim() : '') || await firstRunningSerial(cli)
      if (!buildOnly && !device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' }
      const modules = readModules(projectPath)
      const asked = typeof args?.module === 'string' ? args.module.trim() : ''
      // The marker file is checked to exist above, so an empty list means the names could not be
      // READ (an extreme JSON5 literal `stripJson5` does not cover). Rejecting an explicit
      // module with "模块 X 不属于该工程(可选:无)" was a misleading answer to a readable request:
      // pass it through to hvigor instead, and say the list was unreadable.
      const modulesUnreadable = modules.length === 0
      if (asked && !modulesUnreadable && !modules.includes(asked)) {
        return { ok: false, error: `模块“${asked}”不属于该工程(可选:${modules.join('、')})` }
      }
      const chosen = asked || (modules.includes('entry') ? 'entry' : modules[0])
      const unreadNote = modulesUnreadable
        ? `未能从 build-profile.json5 读出模块名(stripJson5 只覆盖常见 JSON5 写法),本次${asked ? `按你指定的 module=“${asked}”` : '不传 --module'};要精确定位请显式传 module。`
        : ''
      const started = Date.now()
      let output = ''
      let code: number | null = null
      let timedOut = false
      let note = ''
      try {
        if (buildOnly || skipBuild) {
          // The official stage switches, as listed in `build --help` / `run --help`. There is no
          // "install without launching", so that combination is deliberately not offered.
          const argv = buildOnly
            ? [process.execPath, cli, 'build', ...(chosen ? ['--modules', chosen] : [])]
            : [process.execPath, cli, 'run', '--device', device, ...(chosen ? ['--module', chosen] : []), '--skip-build']
          const r = await runCli(argv, { cwd: projectPath, timeoutMs: 20 * 60 * 1000 })
          output = r.output
          code = r.code
          timedOut = r.timedOut
        } else {
          // Reuse the HTTP API's non-streaming path: it already validates the project, checks the
          // device is online and picks the entry module.
          const r = await api.deploy({ projectPath, device, module: chosen })
          output = String(r.output || '')
          code = r.code ?? null
          timedOut = r.timedOut === true
          note = r.note
        }
      } catch (error) {
        const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'internal'
        return { ok: false, device, phase: 'build', durationMs: Date.now() - started, errorCode, error: error instanceof Error ? error.message : String(error) }
      }
      const { errors, errorCount, warnCount } = parseBuildErrors(output)
      const ok = code === 0
      const result: any = {
        ok,
        code,
        timedOut,
        device: device || null,
        module: chosen || null,
        phase: buildOnly ? 'build' : deployPhase(output),
        durationMs: Date.now() - started,
        errors: errors.map((e) => ({ ...e, file: relativeTo(projectPath, e.file) })),
        errorCount,
        warnCount,
      }
      const hap = chosen ? hapPathOf(projectPath, chosen) : null
      if (hap) result.hapPath = hap
      if (!ok && note) result.note = note
      // A readable-looking project whose module list could not be parsed is worth saying out loud,
      // on success too: the caller cannot otherwise tell why `--module` was or was not passed.
      if (unreadNote) result.note = result.note ? `${result.note} ${unreadNote}` : unreadNote
      result.tail = tailText(output, ok ? 6 : 30)
      // A failed install/launch leaves the device showing whatever the app did — the one thing the
      // build log cannot tell. A build-only failure has nothing to look at.
      if (!ok && !buildOnly && device) {
        Object.assign(result, await shotFields(api, device, sessionWorkspace(exec), `deploy-${deployPhase(output)}`, ctx, args?.read === true))
      }
      return result
    },
  }

  const hmosLog = {
    name: 'hmos_log',
    description: 'Read recent device logs via devecocli log, parsed into {time, level, tag, message}. Clearing the buffer is a device command (hdc: hilog -r).',
    parameters: {
      type: 'object',
      properties: {
        bundle: { type: 'string', description: 'bundle name filter' },
        level: { type: 'string', enum: ['D', 'I', 'W', 'E', 'F'], description: 'level filter' },
        keyword: { type: 'string', description: 'keyword filter' },
        crash: { type: 'boolean', description: 'crash logs only' },
        since: { type: 'string', description: 'only logs from this far back (30s, 5m)' },
        tail: { type: 'integer', description: 'latest N lines (50, max 500)' },
        raw: { type: 'boolean', description: 'also return the raw text tail' },
        read: { type: 'boolean', description: 'crash: attach the screenshot taken with the crash log, not just its path' },
        device: { type: 'string', description: 'serial (default: first running)' },
      },
      required: [],
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args, exec) {
      const cli = resolveDevecoCli()
      if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
      const device = (typeof args?.device === 'string' && args.device.trim() ? args.device.trim() : '') || await firstRunningSerial(cli)
      if (!device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' }
      const tail = Number.isFinite(args?.tail) ? Math.max(1, Math.min(500, args.tail)) : 50
      const argv = ['log', '--device', device, '--tail', String(tail)]
      if (args?.crash) argv.push('--crash')
      if (typeof args?.level === 'string' && args.level) argv.push('--level', String(args.level))
      if (typeof args?.bundle === 'string' && args.bundle.trim()) argv.push('--bundle-name', args.bundle.trim())
      if (typeof args?.keyword === 'string' && args.keyword.trim()) argv.push('--keyword', args.keyword.trim())
      if (typeof args?.since === 'string' && args.since.trim()) argv.push('--from', args.since.trim())
      const r = await runCli([process.execPath, cli, ...argv], { timeoutMs: 60000 })
      if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 8) }
      const text = r.output.trim()
      const lines = parseLogLines(r.output).slice(-tail)
      const result: any = { ok: true, device, tail, count: lines.length, lines }
      // Parsed lines are the point of this tool, but a run that parses to nothing (a wrapped or
      // unexpected format) must not look like "no logs", so hand back the raw tail instead.
      if (lines.length === 0) result.rawTail = text.length > 2000 ? text.slice(-2000) : text
      else if (args?.raw) result.rawTail = text.length > 8000 ? text.slice(-8000) : text
      // A crash log names the failure; the screenshot shows what the app was doing when it happened.
      if (args?.crash && lines.length > 0) {
        Object.assign(result, await shotFields(api, device, sessionWorkspace(exec), 'crash', ctx, args?.read === true))
      }
      return result
    },
  }

  const hmosDocs = {
    name: 'hmos_docs',
    description: 'Search/read the official HarmonyOS docs via devecocli docs (offline local set). search: compact id/title/snippet; read: one document, pageable.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'read'] },
        keywords: { type: 'string', description: 'search: phrase, as-is' },
        open: { type: 'integer', description: 'search: also read the first N hits in full (1-3), saving the follow-up read' },
        documentId: { type: 'string', description: 'read: id from a search result' },
        limit: { type: 'integer', description: 'search: max results (5, max 20); read: max chars (8000, max 20000)' },
        offset: { type: 'integer', description: 'read: start at this char (0); continue from nextOffset' },
      },
      required: ['action'],
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args) {
      const cli = resolveDevecoCli()
      if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
      const action = String(args?.action || '')
      if (action === 'search') {
        const keywords = typeof args?.keywords === 'string' ? args.keywords.trim() : ''
        if (!keywords) return { ok: false, error: 'keywords is required' }
        const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(20, args.limit)) : 5
        const argv = [process.execPath, cli, 'docs', 'search', keywords, '--limit', String(limit)]
        const r = await runCli(argv, { timeoutMs: 60000 })
        if (r.code !== 0) return { ok: false, error: tailText(r.output, 6) }
        // Entries look like "<documentId>\n  Title: ...\n  Content: ...", separated by blank lines.
        const entries = r.output.split(/\n\s*\n/).map((chunk) => {
          const lines = chunk.split(/\r?\n/).filter((line) => line.trim() !== '')
          if (lines.length === 0) return null
          const id = lines[0].trim()
          if (id.startsWith('Title:') || id.startsWith('Content:')) return null
          const title = (chunk.match(/Title:\s*(.+)/) || [])[1] || ''
          const content = (chunk.match(/Content:\s*([\s\S]*)/) || [])[1] || ''
          return { id, title: title.trim(), snippet: content.replace(/\s+/g, ' ').trim().slice(0, 140) }
        }).filter(Boolean)
        // a doc lookup is almost always search-then-read, so `open` fetches the body of the
        // first N hits in the same call — the ids and titles in the list are what makes that safe.
        const open = Number.isFinite(args?.open) ? Math.max(0, Math.min(3, Math.floor(args.open))) : 0
        if (open === 0 || entries.length === 0) return { ok: true, count: entries.length, entries }
        const opened: any[] = []
        for (const entry of entries.slice(0, open)) {
          const read = await runCli([process.execPath, cli, 'docs', 'read', entry.id], { timeoutMs: 60000 })
          if (read.code !== 0) { opened.push({ id: entry.id, error: tailText(read.output, 3) }); continue }
          const slice = sliceText(read.output.trim(), 0, 8000)
          opened.push({
            id: entry.id, title: entry.title, total: slice.total,
            ...(slice.nextOffset === null ? {} : { nextOffset: slice.nextOffset }),
            text: slice.text,
          })
        }
        return { ok: true, count: entries.length, entries, opened }
      }
      if (action === 'read') {
        const documentId = typeof args?.documentId === 'string' ? args.documentId.trim() : ''
        if (!documentId) return { ok: false, error: 'documentId is required' }
        const r = await runCli([process.execPath, cli, 'docs', 'read', documentId], { timeoutMs: 60000 })
        if (r.code !== 0) return { ok: false, error: tailText(r.output, 6) }
        const offset = Number.isFinite(args?.offset) ? Math.max(0, Math.floor(args.offset)) : 0
        const limit = Number.isFinite(args?.limit) ? Math.max(500, Math.min(20000, Math.floor(args.limit))) : 8000
        const slice = sliceText(r.output.trim(), offset, limit)
        return {
          ok: true,
          documentId,
          total: slice.total,
          offset: slice.offset,
          // Say where to continue instead of dropping the tail silently.
          ...(slice.nextOffset === null ? {} : { nextOffset: slice.nextOffset }),
          text: slice.text,
        }
      }
      return { ok: false, error: `unknown action ${action}` }
    },
  }

  const hmosLint = {
    name: 'hmos_lint',
    description: 'Run the DevEco code check via devecocli check lint; findings come back structured. changed = uncommitted tracked files under the project, reported as checkedFiles (a non-git project escalates to a full check); new files come back as untrackedFiles (incremental cannot see them); all = whole project.',
    parameters: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: 'project root (contains build-profile.json5)' },
        scope: { type: 'string', enum: ['changed', 'all'], description: 'changed: --incremental (default) | all' },
      },
      required: ['projectPath'],
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args, exec) {
      const cli = resolveDevecoCli()
      if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
      const project = projectRootOf(args?.projectPath, exec)
      if (!project) return { ok: false, error: 'projectPath is required' }
      if (!existsSync(project)) return { ok: false, error: `应用工程路径不存在:${project}` }
      if (!existsSync(join(project, PROJECT_MARK))) {
        return { ok: false, error: `未找到 ${PROJECT_MARK}:已按 ${project} 查找(传目录时请给工程根,相对路径按会话工作区解析)。` }
      }
      let full = args?.scope === 'all'
      let escalated = false
      let checkedFiles: string[] | null = null
      let untrackedFiles: string[] = []
      if (!full) {
        // One git call for both halves: the tracked set decides the scope, the untracked set is what
        // `--incremental` cannot see and therefore has to be reported.
        const status = await codeStatusFiles(project)
        const changed = status === null ? null : status.changed
        untrackedFiles = status === null ? [] : status.untracked
        // `--incremental` without a usable change set can inspect almost nothing and then report a
        // clean summary; a slow full run is the only honest answer (see lintScope).
        const scope = lintScope('changed', changed)
        full = scope.full
        escalated = scope.escalated
        checkedFiles = scope.checkedFiles
      }
      const argv = [process.execPath, cli, 'check', 'lint', project]
      if (!full) argv.push('--incremental')
      // cwd = project: codelinter prints File paths relative to the process cwd,
      // so this is what makes the returned paths project-relative instead of host-cwd-relative.
      const r = await runCli(argv, { cwd: project, timeoutMs: full ? 600000 : 300000 })
      const { findings, summary } = parseLintTable(r.output)
      const bySeverity = (want: string) => findings.filter((f) => f.severity === want)
      const errors = bySeverity('Error')
      const warnings = bySeverity('Warning')
      const suggestions = bySeverity('Suggestion')
      const outcome = lintOutcome(summary, full ? 'all' : 'changed', checkedFiles ? checkedFiles.length : null)
      const cap = 40
      return {
        ok: errors.length === 0,
        code: r.code,
        timedOut: r.timedOut,
        projectPath: project,
        scope: full ? 'all' : 'changed',
        // What `changed` actually covered, so a caller can tell "checked and clean" from "never
        // looked at it".
        scopeBasis: full ? 'all' : 'git',
        ...(escalated ? { escalated: true, escalatedWhy: '非 git 工程或 git 不可用,已自动改为全量检查' } : {}),
        ...(checkedFiles ? { checkedFiles } : {}),
        // New files are outside `--incremental` by construction; saying so is the difference between
        // "clean" and "never looked at the file you just added".
        ...(untrackedFiles.length > 0
          ? {
              untrackedFiles,
              note: `${untrackedFiles.length} 个新建(未跟踪)文件不在 --incremental 覆盖范围内;要检查它们请用 scope:'all',或先 git add。`,
            }
          : {}),
        empty: outcome.empty,
        summary: summary
          ? { issues: summary.issues, errors: summary.errors, warnings: summary.warnings, suggestions: summary.suggestions, filesChecked: summary.files }
          : null,
        errors: errors.slice(0, cap),
        warnings: warnings.slice(0, cap),
        suggestions: suggestions.slice(0, cap),
        omitted: {
          errors: Math.max(0, errors.length - cap),
          warnings: Math.max(0, warnings.length - cap),
          suggestions: Math.max(0, suggestions.length - cap),
        },
        stats: outcome.stats,
        rawTail: tailText(r.output, 2),
      }
    },
  }

  return [emu, emuUi, hmosDeploy, hmosLog, hmosDocs, hmosLint]
}

export function apply(ctx: Ctx, _config?: any) {
  // Isolation: never throw from host apply; log only, so the DSH composition keeps loading.
  try {
    const api = createApi()
    let registered = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    const registerOnce = () => {
      if (disposed || registered) return
      try {
        const ws = ctx.get('webServer') as any
        if (ws === undefined || typeof ws.register !== 'function') {
          // Non-blocking wait: retry until webServer is ready; never block or abort boot.
          timer = setTimeout(registerOnce, 700)
          return
        }
        registered = true
        ctx.effect(() => ws.register({
          kind: 'prefix',
          path: API_PREFIX,
          handler: async (req, res) => {
            try {
              if (req.method !== 'POST') {
                writeJson(res, 405, { ok: false, error: { code: 'method', message: 'only POST' } })
                return
              }
              // Fence first, before any method lookup: a rebound or cross-site caller must not
              // learn which methods exist, let alone reach install / lint --fix / deploy.
              // Read per request so the authorities stay whatever DSH currently publishes.
              if (!trustRequest(req, fenceAuthorities(ctx.get('webRuntime'), ws.host))) {
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
                  await handler(payload, res)
                } catch (error) {
                  if (!res.headersSent) writeError(res, error)
                  else {
                    try { res.write(`\n[HMOS_EXIT]=-2\n`) } catch { /* ignore */ }
                    try { res.end() } catch { /* ignore */ }
                  }
                }
                return
              }
              const value = await handler(payload)
              writeOk(res, value)
            } catch (error) {
              writeError(res, error)
            }
          },
        }), 'dsh-hmos-emulator: http api')
      } catch (error) {
        console.error('[dsh-hmos-emulator] 宿主路由注册异常(已隔离,不影响 DSH):', error)
      }
    }
    registerOnce()
    // Register model tools the same non-blocking way (no inject, to avoid aborting composition).
    const defs = createToolDefs(api, ctx)
    let toolsRegistered = false
    let toolsTimer: ReturnType<typeof setTimeout> | null = null
    const registerTools = () => {
      if (disposed || toolsRegistered) return
      try {
        const tools = ctx.get('tools') as any
        if (tools === undefined || typeof tools.register !== 'function') {
          toolsTimer = setTimeout(registerTools, 700)
          return
        }
        toolsRegistered = true
        const disposers = []
        for (const def of defs) disposers.push(tools.register(def))
        ctx.effect(() => () => {
          for (const d of disposers) { try { if (typeof d === 'function') d() } catch { /* ignore */ } }
        }, 'dsh-hmos-emulator: model tools')
      } catch (error) {
        console.error('[dsh-hmos-emulator] Model Tool 注册异常(已隔离,不影响 DSH):', error)
      }
    }
    registerTools()
    // Runtime-context provider: hands the latest code-check result to the model on its next
    // prompt assembly, so the user never has to copy it out of the panel. Non-blocking wait
    // like the others; the text function is evaluated per assembly.
    let lintContextRegistered = false
    let lintTimer: ReturnType<typeof setTimeout> | null = null
    const registerLintContext = () => {
      if (disposed || lintContextRegistered) return
      try {
        const sp = ctx.get('systemPrompt') as any
        if (sp === undefined || typeof sp.context !== 'function') {
          lintTimer = setTimeout(registerLintContext, 700)
          return
        }
        lintContextRegistered = true
        ctx.effect(() => sp.context({
          name: 'hmos-emulator-code-check',
          order: 990,
          text: (assemble) => {
            if (!lintNotice || lintDeliveries >= 1) return ''
            // `assemble.scope` is the asking session's Agent object, and ctx.agents.get(id) hands
            // back that same object, so identity is the exact test. Only filter when the owner can
            // actually be identified: an older client sends no session id, and a host without the
            // agents service must keep delivering instead of stranding the notice forever.
            const agents = ctx.get('agents') as any
            if (lintNoticeSession && agents && typeof agents.get === 'function') {
              const owner = agents.get(lintNoticeSession)
              if (owner !== undefined && assemble?.scope !== owner) return ''
            }
            lintDeliveries += 1
            return lintNotice
          },
        }), 'dsh-hmos-emulator: code-check context')
      } catch (error) {
        console.error('[dsh-hmos-emulator] 检查结果上下文注册异常(已隔离,不影响 DSH):', error)
      }
    }
    registerLintContext()
    // Stop waiting / dispose registered resources on unload.
    ctx.effect(() => () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (toolsTimer) clearTimeout(toolsTimer)
      if (lintTimer) clearTimeout(lintTimer)
    })
  } catch (error) {
    console.error('[dsh-hmos-emulator] 宿主 apply 异常(已隔离,不影响 DSH 启动):', error)
  }
}

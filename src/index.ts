/**
 * dsh-hmos-emulator — host half.
 *
 * Turns better-sidebar tab actions into real local work: toolchain discovery,
 * emulator start/stop, device listing, project browsing, build+deploy, screenshots,
 * and two model tools (emu / emu_ui) so an agent can drive the emulator directly.
 *
 * The client calls this module over same-origin HTTP JSON (prefix /dsh-hmos-emulator/api)
 * with the envelope { ok: true, value } / { ok: false, error: { code, message } }.
 *
 * Imports no cordis/dsh runtime package: only the ctx API and Node builtins, so it shares
 * the host runtime instance and can mount in any host context.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

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
  'devices', 'browse', 'scan', 'project.info', 'deploy', 'device.ready', 'deveco.install', 'deveco.update', 'screenshot',
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

function resolveDevecoCli() {
  // 1) explicit env var wins
  const explicit = process.env.DSH_HMOS_DEVECO_CLI || ''
  if (explicit && existsSync(explicit)) return explicit
  // 2) reverse-derive the npm global root from the devecocli shim on PATH
  const shim = whichFirst('devecocli')
  if (shim) {
    for (const line of [shim]) {
      const dir = dirname(line)
      const cli = cliUnderNpmRoot(dir)
      if (cli) return cli
    }
    // the shim may sit in the npm root itself; its parent still holds the global root
    const parent = dirname(shim)
    const cli = cliUnderNpmRoot(parent)
    if (cli) return cli
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

function listDirs(dir) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    throw Object.assign(new Error(`无法读取目录:${error instanceof Error ? error.message : String(error)}`), { code: 'fs-error' })
  }
  const result = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
    if (result.length >= 300) break
    result.push({
      name: entry.name,
      isProject: existsSync(join(dir, entry.name, PROJECT_MARK)),
    })
  }
  result.sort((a, b) => Number(b.isProject) - Number(a.isProject) || a.name.localeCompare(b.name))
  return result
}

function scanProjects(root, maxDepth = 3) {
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

/** Minimal JSON5→JSON: strip comments, quote bare keys, drop trailing commas, then JSON.parse. */
function stripJson5(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
    .replace(/,\s*([}\]])/g, '$1')
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

function createApi(config) {
  const api: Record<string, (payload?: any, res?: any) => Promise<any>> = {}

  api.toolchain = async () => {
    const sdk = process.env.DEVECO_SDK_HOME || config?.sdkHome || ''
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
    return {
      platform: process.platform,
      home: homedir(),
      node: process.execPath,
      devecoCliJs: cliPath ?? null,
      devecoCliVersion: cliVersion,
      hdcExe: resolveHdc() ?? null,
      sdkHome: sdk || null,
      hint:
        'devecocli 缺失时:安装 @deveco/deveco-cli 或设置环境变量 DSH_HMOS_DEVECO_CLI。' +
        `hdc 缺失时:设置 DEVECO_SDK_HOME(${sdkExample})后重启 dsh web。`,
    }
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
    const argv = [process.execPath, cli, 'emulator', 'start', name]
    // A headless Linux host must pass -noWindow (official constraint) or start fails.
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) argv.push('-noWindow')
    const result = await runCli(argv, { timeoutMs: 240000 })
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

  api.browse = async (payload) => {
    const root = normalizeDir(payload?.path)
    return {
      root,
      parent: dirname(root) === root ? null : dirname(root),
      dirs: listDirs(root),
    }
  }

  api.scan = async (payload) => {
    const root = normalizeDir(payload?.root)
    const paths = scanProjects(root)
    return { root, projects: paths }
  }

  api['project.info'] = async (payload) => {
    const project = typeof payload?.projectPath === 'string' ? resolve(payload.projectPath) : ''
    if (!project || !existsSync(project)) throw Object.assign(new Error('应用工程路径不存在'), { code: 'bad-request' })
    return { modules: readModules(project) }
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
      const { code, timedOut } = await runCliStream(cmd, {
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
  // PNG path makes the CLI write that exact file (verified), so no auto-name parsing.
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
    const file = join(dir, `hmos-shot-${Date.now()}-${safe}.png`)
    const result = await runCli([process.execPath, cli, 'ui', 'screenshot', '--device', device, '--path', file], { timeoutMs: 60000 })
    if (result.code !== 0 || !existsSync(file)) {
      const why = result.timedOut ? '超时' : result.code === 0 ? '未生成文件' : `退出码 ${result.code}`
      throw new Error(`截图失败(${why}):\n${result.output}`)
    }
    return { path: file, device, dataUrl: payload?.preview ? readDataUrl(file) : null }
  }

  return api
}

// ── Route wiring ────────────────────────────────────────────────────────

function readBody(req: any): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    req.on('data', (chunk) => {
      chunks.push(chunk)
      if (chunks.reduce((sum, c) => sum + c.length, 0) > 1_000_000) {
        rejectBody(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectBody)
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
  const status = code === 'bad-request' || code === 'toolchain' || code === 'fs-error' || code === 'image-missing' ? 400 : 500
  writeJson(res, status, { ok: false, error: { code, message } })
}

// ── Model Tools (AI-friendly: two thin wrappers, tiny resident schema) ───

/** Tool output is compact JSON (no indentation) to save tokens. */
const TOOL_OUT_SCHEMA = { type: 'object', additionalProperties: true }
const toolRender = (args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]

/** Keep the last n non-empty lines (trims command output before it reaches context). */
function tailText(text, n) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '')
  return lines.slice(-n).join('\n')
}

/** Serial of the first running emulator (default target for emu_ui). */
async function firstRunningSerial(cli) {
  const r = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 20000 })
  const inst = parseJsonArray(r.output).find((it) => it && typeof it.serial === 'string' && it.serial && /running/i.test(String(it.status)))
  return inst ? inst.serial : ''
}

/**
 * Two model tools:
 *  - emu    : instance list/start/stop (reuses image precheck + readiness polling)
 *  - emu_ui : inspect/drive the screen through devecocli ui (compact layout tree, label click)
 */
function createToolDefs(api) {
  const emu = {
    name: 'emu',
    description: 'Control HarmonyOS emulators through devecocli: list instances, start (pre-checks the system image, waits until the device is online), stop. Use emu_ui for screen inspection/interaction.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'start', 'stop'], description: 'list = instances; start = launch and wait until online; stop = shut down' },
        name: { type: 'string', description: 'Emulator instance name (required for start/stop)' },
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
        const argv = [process.execPath, cli, 'emulator', 'start', name]
        if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) argv.push('-noWindow')
        const r = await runCli(argv, { timeoutMs: 240000 })
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

  const emuUi = {
    name: 'emu_ui',
    description: 'Inspect and drive the emulator screen via devecocli ui. layout = compact control tree lines (type [x1,y1,x2,y2] "text" clickable); click = tap by label (runs layout and taps that node center, one call), or by x/y; text/swipe = input; screenshot = save a PNG and return its path (view with read_image).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['layout', 'click', 'text', 'swipe', 'screenshot'], description: 'UI action' },
        device: { type: 'string', description: 'Target serial; defaults to the first running emulator' },
        label: { type: 'string', description: 'click: text of a layout node; the tool runs layout, finds it, and taps its center (one call instead of layout + click)' },
        thenLayout: { type: 'boolean', description: 'click: after tapping, take a fresh layout and return it as tree (verifies the result without a second call)' },
        waitMs: { type: 'integer', description: 'click + thenLayout: delay before the fresh layout, ms (default 600, max 5000)' },
        x: { type: 'integer', description: 'click x, or swipe start x' },
        y: { type: 'integer', description: 'click y, or swipe start y' },
        x2: { type: 'integer', description: 'swipe end x' },
        y2: { type: 'integer', description: 'swipe end y' },
        text: { type: 'string', description: 'text to input' },
        depth: { type: 'integer', description: 'layout tree depth (0 = unlimited); use to narrow large trees' },
        root: { type: 'string', description: 'screenshot root dir (PNG goes to <root>/screenshots); defaults to process cwd' },
      },
      required: ['action'],
    },
    output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
    async execute(args) {
      const cli = resolveDevecoCli()
      if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
      const action = String(args?.action || '')
      const device = (typeof args?.device === 'string' && args.device.trim() ? args.device.trim() : '') || await firstRunningSerial(cli)
      if (!device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' }
      const run = (argv, timeoutMs) => runCli([process.execPath, cli, ...argv], { timeoutMs })

      if (action === 'layout') {
        const argv = ['ui', 'layout', '--device', device]
        if (Number.isFinite(args?.depth)) argv.push('--depth', String(args.depth))
        const r = await run(argv, 30000)
        if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 6) }
        const tree = r.output.split(/\r?\n/).filter((l) => l.trim() !== '' && !/Dumping layout/i.test(l)).join('\n')
        return { ok: true, device, tree: tree.length > 6000 ? `${tree.slice(0, 6000)}\n…(truncated; pass depth to narrow)` : tree }
      }
      if (action === 'click') {
        let argv = ['ui', 'click', '--device', device]
        let point = null
        let matched = ''
        if (Number.isFinite(args?.x) && Number.isFinite(args?.y)) {
          point = { x: args.x, y: args.y }
          argv.push(String(args.x), String(args.y))
        } else if (typeof args?.label === 'string' && args.label.trim()) {
          // Resolve a label to its center in one call: avoids a layout round-trip before click.
          const lr = await run(['ui', 'layout', '--device', device], 30000)
          if (lr.code !== 0) return { ok: false, device, error: tailText(lr.output, 6) }
          const line = lr.output.split(/\r?\n/).find((l) => l.includes(args.label))
          const m = line ? line.match(/\[(\d+),(\d+),(\d+),(\d+)\]/) : null
          if (!m) return { ok: false, device, error: `no layout node matching "${args.label}"` }
          point = { x: Math.round((Number(m[1]) + Number(m[3])) / 2), y: Math.round((Number(m[2]) + Number(m[4])) / 2) }
          matched = line.trim()
          argv = ['ui', 'click', String(point.x), String(point.y), '--device', device]
        } else return { ok: false, error: 'click needs label or x/y' }
        const r = await run(argv, 20000)
        if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 4) }
        const result: any = { ok: true, device, x: point.x, y: point.y }
        if (matched) result.matched = matched
        // thenLayout verifies the tap in the same call: a fresh layout after a short settle delay.
        if (args?.thenLayout) {
          const wait = Number.isFinite(args?.waitMs) ? Math.max(0, Math.min(5000, args.waitMs)) : 600
          if (wait > 0) await new Promise((resolveWait) => setTimeout(resolveWait, wait))
          const after = await run(['ui', 'layout', '--device', device], 30000)
          result.tree = after.code === 0
            ? after.output.split(/\r?\n/).filter((l) => l.trim() !== '' && !/Dumping layout/i.test(l)).join('\n')
            : tailText(after.output, 4)
        }
        return result
      }
      if (action === 'text') {
        const value = typeof args?.text === 'string' ? args.text : ''
        if (!value) return { ok: false, error: 'text is required' }
        const r = await run(['ui', 'text', value, '--device', device], 20000)
        return { ok: r.code === 0, device, error: r.code === 0 ? '' : tailText(r.output, 4) }
      }
      if (action === 'swipe') {
        if (![args?.x, args?.y, args?.x2, args?.y2].every((n) => Number.isFinite(n))) return { ok: false, error: 'swipe needs x, y, x2, y2' }
        const r = await run(['ui', 'swipe', String(args.x), String(args.y), String(args.x2), String(args.y2), '--device', device], 20000)
        return { ok: r.code === 0, device, error: r.code === 0 ? '' : tailText(r.output, 4) }
      }
      if (action === 'screenshot') {
        const root = typeof args?.root === 'string' && args.root.trim() ? args.root.trim() : process.cwd()
        const value = await api.screenshot({ device, root })
        return { ok: true, path: value.path, device: value.device }
      }
      return { ok: false, error: `unknown action ${action}` }
    },
  }

  return [emu, emuUi]
}

export function apply(ctx: Ctx, config?: any) {
  // Isolation: never throw from host apply; log only, so the DSH composition keeps loading.
  try {
    const api = createApi(config ?? {})
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
    const defs = createToolDefs(api)
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
    // Stop waiting / dispose registered resources on unload.
    ctx.effect(() => () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (toolsTimer) clearTimeout(toolsTimer)
    })
  } catch (error) {
    console.error('[dsh-hmos-emulator] 宿主 apply 异常(已隔离,不影响 DSH 启动):', error)
  }
}

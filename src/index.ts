/**
 * dsh-hmos-emulator — 宿主端(half)。
 *
 * 职责:把 better-sidebar 标签页里的按钮变成真实的本机动作——
 *  - 探测工具链(devecocli / hdc);
 *  - 启动/停止鸿蒙模拟器(devecocli emulator);
 *  - 列出已连接设备(devecocli device list --format json,跨平台);
 *  - 本地目录浏览 / 工程探测(node:fs),供“应用项目文件浏览器”使用;
 *  - 构建并把应用部署到模拟器(devecocli run --device)。
 *
 * 客户端通过同源 HTTP JSON API 调用本模块(前缀 /dsh-hmos-emulator/api),
 * 返回统一信封 { ok: true, value } / { ok: false, error: { code, message } }。
 *
 * 不 import 任何 cordis/dsh 运行时包:仅用 ctx API 与 Node 内建能力,
 * 因此与宿主进程共享同一套运行时实例,可在任意 host 上下文挂载。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

/** 轻量 cordis 上下文类型:仅声明本插件用到的能力,避免依赖整个 DSH 类型图。 */
export interface Ctx {
  get(name: string): any
  effect(callback: () => any, label?: string): void
}

export const name = 'dsh-hmos-emulator'

// 注意:不要在此声明 `inject: ['webServer']` —— 那会让 loader 在启动时把 webServer
// 当作硬依赖处理,中断整个 composition 加载(曾导致宿主端其余插件如 dsh-mneme 不挂载、
// 记忆全部加载失败)。改用下方“就绪后注册”的轮询方案,非阻塞且一定能注册成功。


/** HTTP API 前缀(与 client.js 一致;全机唯一,勿与其他插件冲突)。 */
const API_PREFIX = '/dsh-hmos-emulator/api'
/** 允许的 API 方法白名单(避免成为任意命令执行口)。 */
const METHODS = new Set([
  'toolchain', 'emu.list', 'emu.start', 'emu.stop',
  'devices', 'browse', 'scan', 'project.info', 'deploy', 'device.ready', 'deveco.install', 'deveco.update', 'screenshot',
])
/** 这些方法由处理函数直接写 res(流式),不套统一 JSON 信封。 */
const STREAMING_METHODS = new Set(['deploy'])
/** 目录浏览/扫描时跳过的目录。 */
const IGNORED_DIRS = new Set([
  'node_modules', 'oh_modules', '.git', '.hvigor', '.idea', '.ohpm',
  '.preview', '.cxx', '.appanalyzer', 'build',
])
/** 判定“这是一个鸿蒙工程根”的标记文件。 */
const PROJECT_MARK = 'build-profile.json5'
/** 单次响应里保留的输出上限(取尾部,防超大构建日志打爆浏览器)。 */
const OUTPUT_TAIL = 80000

// ── 工具链探测 ──────────────────────────────────────────────────────────

/** 执行一个命令并取回第一行(用于 where/which 等探测)。 */
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

/** 依据 npm 全局目录推算 @deveco/deveco-cli 的 node 入口。 */
function cliUnderNpmRoot(npmRoot) {
  if (!npmRoot) return undefined
  const cli = join(npmRoot, 'node_modules', '@deveco', 'deveco-cli', 'dist', 'cli.js')
  return existsSync(cli) ? cli : undefined
}

function resolveDevecoCli() {
  // 1) 显式配置/环境变量优先
  const explicit = process.env.DSH_HMOS_DEVECO_CLI || ''
  if (explicit && existsSync(explicit)) return explicit
  // 2) 从 PATH 上的 devecocli 垫片反推 npm 全局目录
  const shim = whichFirst('devecocli')
  if (shim) {
    for (const line of [shim]) {
      const dir = dirname(line)
      const cli = cliUnderNpmRoot(dir)
      if (cli) return cli
    }
    // 若垫片在 <npmRoot> 根,其上级目录仍是全局目录的一部分
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
    /* 忽略探测失败 */
  }
  return undefined
}

function resolveHdc() {
  // hdc 二进制名随平台:Windows 为 .exe,macOS/Linux 无扩展名。
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

// ── 子进程执行 ──────────────────────────────────────────────────────────

/**
 * 运行一次本地命令,返回 { code, timedOut, output }。
 * - spawn 层面失败(EPERM/ENOENT 等)在 output 中给出可读原因,code 为 null;
 * - 超时后杀掉进程树并标记 timedOut(模拟器冷启动/长构建常见)。
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
      try { child.kill() } catch { /* 忽略 */ }
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
 * 流式执行命令:每产生一段输出就回调 onChunk(供部署日志实时推送)。
 * 返回 { code, timedOut };不缓存整段输出,适合长任务。
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
      try { child.kill() } catch { /* 忽略 */ }
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

// ── 本地文件系统(应用项目选择器用) ────────────────────────────────────

/** 把任意输入规整为存在的绝对目录(逐级上溯,最多 6 层)。 */
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

// ── 工程信息(多模块部署用) ──────────────────────────────────────────────

/** 极简 JSON5→JSON:去掉 // 与 /* *\/ 注释、给裸键加引号、删行尾逗号,再 JSON.parse。 */
function stripJson5(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3')
    .replace(/,\s*([}\]])/g, '$1')
}

/** 读取鸿蒙工程的入口模块名(build-profile.json5 的 modules[].name)。解析失败返回 []。 */
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

// ── 模拟器启动辅助(镜像预检 / 就绪轮询) ────────────────────────────────

/** 读取 PNG 为 data URL(供面板内预览);失败返回 null。 */
function readDataUrl(file) {
  try {
    return `data:image/png;base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}

/** 解析 devecocli 的 --format json 数组输出;失败返回 []。 */
function parseJsonArray(output) {  try {
    const arr = JSON.parse(output)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/**
 * 启动前预检:该实例所需系统镜像是否已被 devecocli 判定为「已下载」。
 * 未下载时抛出带可执行修复命令的错误(code=image-missing),
 * 免得把 devecocli 的原始报错(cannot be found, download it again)直接丢给用户。
 * 查询失败或信息不足时不阻断,交给 start 自身报错。
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
 * 启动后等待设备真正上线:轮询实例 serial 与设备列表,直到在线或超时。
 * 返回 { ready, serial }(serial 在轮询过程中一旦拿到即回传)。
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

// ── API 方法实现 ────────────────────────────────────────────────────────

function createApi(config) {
  const api: Record<string, (payload?: any, res?: any) => Promise<any>> = {}

  api.toolchain = async () => {
    const sdk = process.env.DEVECO_SDK_HOME || config?.sdkHome || ''
    const cliPath = resolveDevecoCli()
    // 本地 devecocli 版本(供面板展示/判断是否需要更新)。
    let cliVersion = null
    if (cliPath) {
      const v = await runCli([process.execPath, cliPath, '--version'], { timeoutMs: 20000 })
      if (v.code === 0) cliVersion = (v.output.trim().split(/\r?\n/)[0] || '') || null
    }
    // 提示里给出当前平台下 DevEco Studio SDK 的示例路径(避免硬编码 Windows 路径)。
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
    // 一键在用户机器全局安装 @deveco/deveco-cli(仅覆盖 CLI;hdc/模拟器仍需 DevEco Studio SDK)。
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
    // 官方 JSON 输出最稳定;部分 devecocli 版本在 JSON 前后混入日志行,故截取 [..] 段解析。
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
    // 预检系统镜像:缺失时直接给出可执行的下载命令(而不是让用户面对原始报错)。
    await ensureImageReady(cli, name)
    const argv = [process.execPath, cli, 'emulator', 'start', name]
    // 无图形界面的 Linux 环境必须加 -noWindow(官方约束),否则启动必失败。
    if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) argv.push('-noWindow')
    const result = await runCli(argv, { timeoutMs: 240000 })
    if (result.code !== 0) return { code: result.code, timedOut: result.timedOut, output: result.output, ready: false, serial: null }
    // 启动成功后自动等待设备上线(替代手动点“检测就绪”)。
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
      // 用 devecocli 枚举设备(跨平台),而非硬编码 hdc 路径。
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
    // 设备在线预检(用 devecocli,跨平台):避免对已离线设备盲目发起数分钟的构建。
    if (cli) {
      const probe = await runCli([process.execPath, cli, 'device', 'list', '--format', 'json'], { timeoutMs: 15000 })
      let online = false
      if (probe.code === 0) {
        try {
          const arr = JSON.parse(probe.output)
          online = Array.isArray(arr) && arr.some((d) => { const s = typeof d === 'string' ? d : (d && (d.serial || d.name)); return s === device })
        } catch { /* 解析失败则跳过预检,交给 run 报错 */ }
      }
      if (!online) {
        throw Object.assign(new Error(`设备 ${device} 当前未在线——请先点“启动”模拟器(或连接设备),再点“扫描可用”后重试`), { code: 'device-offline' })
      }
    }
    // 多入口模块:检测 modules,自动指定 --module(默认 entry,否则第一个)。
    const modules = readModules(project)
    const chosen = payload?.module ? String(payload.module) : modules.includes('entry') ? 'entry' : modules[0]
    const cmd = [process.execPath, cli, 'run', '--device', device]
    if (chosen) cmd.push('--module', chosen)
    const note = (code: number | null) => code === 0
      ? '构建、安装、启动完成。(hvigor 的 “No signingConfigs” 只是警告,模拟器可装未签名 debug 包)'
      : '部署失败,请查看上方输出;常见原因:签名未配置 / 设备未就绪。'
    // 流式:边跑边推给 res(供面板实时显示)。
    // cache-control 必须带 no-transform:DSH webServer 默认开 gzip(compression 中间件),
    // 会把 text/plain chunked 响应代理进 zlib 且不自动 flush——日志会攒到结束才一次性到达,
    // 退化为"非实时"。no-transform 是标准豁免,令中间件透传,响应保持 identity 逐行送达。
    if (res && typeof res.write === 'function') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache, no-transform' })
      res.write(`[dsh-hmos-emulator] 部署 ${device}${chosen ? `(模块 ${chosen})` : ''}\n`)
      const { code, timedOut } = await runCliStream(cmd, {
        cwd: project,
        timeoutMs: 20 * 60 * 1000,
        onChunk: (chunk) => { try { res.write(chunk) } catch { /* 客户端已断开 */ } },
      })
      res.write(`\n${note(code)}\n`)
      res.write(`[HMOS_EXIT]=${code ?? -1}\n`)
      res.end()
      return
    }
    // 非流式(向下兼容/测试用):攒整段返回。
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
      } catch { /* 解析失败则视为不在线 */ }
    }
    return { online, serial, devices }
  }

  // 设备截屏:用 devecocli ui screenshot(官方命令,不直接走 hdc)。
  //  --path 传完整 PNG 文件路径即可按给定名直接落盘(实测确认),免去解析自动命名。
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

// ── 路由装配 ────────────────────────────────────────────────────────────

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

export function apply(ctx: Ctx, config?: any) {
  // 隔离:宿主 apply 的任何异常都只打日志,绝不抛出,避免中断 DSH composition 加载。
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
          // 非阻塞等待:webServer 尚未就绪则稍后重试,绝不阻塞/中断启动链。
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
              // 流式方法:处理函数直接写 res(自己管理头/结束),错误按是否已发头处理。
              if (STREAMING_METHODS.has(method)) {
                try {
                  await handler(payload, res)
                } catch (error) {
                  if (!res.headersSent) writeError(res, error)
                  else {
                    try { res.write(`\n[HMOS_EXIT]=-2\n`) } catch { /* 忽略 */ }
                    try { res.end() } catch { /* 忽略 */ }
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
    // 卸载时停止等待/清理已注册资源。
    ctx.effect(() => () => {
      disposed = true
      if (timer) clearTimeout(timer)
    })
  } catch (error) {
    console.error('[dsh-hmos-emulator] 宿主 apply 异常(已隔离,不影响 DSH 启动):', error)
  }
}

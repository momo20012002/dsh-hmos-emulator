import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { AUTO_SHOT_PREFIX, TOOL_SHOT_PREFIX, pruneAutoShots, pruneToolShots, readDataUrl } from './shots.js'
import { countChangedCode, hashTree } from './git.js'
import { devecoCliHint, ensureImageReady, resolveDevecoCli, resolveHdc, runCli, runCliStream, waitDeviceReady } from './toolchain.js'
import { headText, tailText } from './text.js'
import { LINT_LABELS, fixStats, lintOutcome, parseLintSummary } from './parsers/lint.js'
import { PROJECT_MARK, normalizeDir, readModules, scanProjects } from './workspace.js'
/**
 * The HTTP API behind the panel: toolchain, emulator, device, project, lint and deploy methods,
 * plus the background the model tools read through. Nothing here touches a model tool schema.
 */
// Latest code-check result. It is cached here on every check, and only handed to the model
// when the user presses "send to AI" (lint.notify) — never automatically. The queued notice also
// remembers which session asked for it: this module is shared by every session, so without that
// the first session to assemble a prompt would receive another session's result.
export let lastLintNotice = ''
export let lintNotice = ''
export let lintNoticeSession = ''
export let lintDeliveries = 0

/** The context hook counts its deliveries; the state lives here, next to what fills it. */
export function markLintDelivered() { lintDeliveries += 1 }

export function createApi() {
  /** `ctl` carries the caller's abort signal: the route's response-close controller, or a tool's exec.signal. */
  const api: Record<string, (payload?: any, res?: any, ctl?: { signal?: AbortSignal }) => Promise<any>> = {}

  /**
   * The report below is session-stable (paths, versions) but costs a devecocli spawn — ~0.6 s on
   * Windows, mostly Node startup — and the panel asks for it on every open, so it is the single
   * biggest part of the wait before the panel's first paint. `refresh: true` bypasses the cache
   * (the panel's own "刷新" button, and the install/update path where the version really did change).
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

  api['deveco.update'] = async (_payload, _res, ctl) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const result = await runCli([process.execPath, cli, 'update'], { timeoutMs: 240000, signal: ctl?.signal })
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

  api['emu.start'] = async (payload, _res, ctl) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const name = typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim() : null
    if (!name) throw Object.assign(new Error('缺少模拟器实例名(先执行“列出模拟器”查看实例名)'), { code: 'bad-request' })
    // Pre-check the system image so a miss returns the exact download command.
    const signal = ctl?.signal
    await ensureImageReady(cli, name, signal)
    const result = await runCli([process.execPath, cli, 'emulator', 'start', name], { timeoutMs: 240000, signal })
    if (result.aborted) return { code: null, timedOut: false, aborted: true, output: result.output, ready: false, serial: null }
    if (result.code !== 0) return { code: result.code, timedOut: result.timedOut, output: result.output, ready: false, serial: null }
    // Wait for the device to come online (replaces the manual readiness button).
    const { ready, serial, aborted } = await waitDeviceReady(cli, name, { signal })
    return { code: result.code, timedOut: result.timedOut, aborted, output: result.output, ready, serial }
  }

  api['emu.stop'] = async (payload, _res, ctl) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const target = typeof payload?.target === 'string' && payload.target.trim() ? payload.target.trim() : null
    if (!target) throw Object.assign(new Error('缺少要停止的模拟器名称或串号'), { code: 'bad-request' })
    const result = await runCli([process.execPath, cli, 'emulator', 'stop', target], { timeoutMs: 60000, signal: ctl?.signal })
    return { code: result.code, timedOut: result.timedOut, aborted: result.aborted, output: result.output }
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
  api['check.lint'] = async (payload, _res, ctl) => {
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
    const fixRun = await runCli(argv, { timeoutMs, signal: ctl?.signal })
    // The reported state always comes from a plain check, never from a --fix run's own summary.
    const check = fixing ? await runCli(argv.filter((a) => a !== '--fix'), { timeoutMs, signal: ctl?.signal }) : fixRun
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

  api.deploy = async (payload, res, ctl) => {
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
      const probe = await runCli([process.execPath, cli, 'device', 'list', '--format', 'json'], { timeoutMs: 15000, signal: ctl?.signal })
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
      const { code, aborted } = await runCliStream(cmd, {
        cwd: project,
        timeoutMs: 20 * 60 * 1000,
        signal: ctl?.signal,
        onChunk: (chunk) => { try { res.write(chunk) } catch { /* client disconnected */ } },
      })
      // -2 is the route's "did not finish" marker; the panel renders it as such either way.
      res.write(`\n${aborted ? '已取消:构建进程已终止,设备已释放。' : note(code)}\n`)
      res.write(`[HMOS_EXIT]=${aborted ? -2 : code ?? -1}\n`)
      res.end()
      return
    }
    // Non-streaming path (backwards compatible / tests): buffer the whole output.
    const result = await runCli(cmd, { cwd: project, timeoutMs: 20 * 60 * 1000, signal: ctl?.signal })
    return {
      code: result.code,
      timedOut: result.timedOut,
      aborted: result.aborted,
      output: result.output,
      note: result.aborted ? '已取消:构建进程已终止。' : note(result.code),
    }
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

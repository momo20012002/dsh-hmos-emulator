import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { AUTO_SHOT_PREFIX, TOOL_SHOT_PREFIX, pruneAutoShots, pruneToolShots, readDataUrl } from './shots.js'
import { countChangedCode, hashTree } from './git.js'
import { authStatus, cliChannel, cliInstallSpec, cliUpdateChannel, devecoCliHint, ensureImageReady, firstRunningSerial, npmCommand, npmInvocation, resolveDevecoCli, resolveHdc, runCli, runCliStream, versionFromOutput, waitDeviceReady } from './toolchain.js'
import { headText, tailText } from './text.js'
import { LINT_LABELS, fixStats, lintOutcome, parseLintSummary } from './parsers/lint.js'
import { PROJECT_MARK, moduleName, normalizeDir, readModules, scanProjects } from './workspace.js'
import { absoluteLocal, localPathFor } from './local-path.js'
/**
 * Parse a `--format json` answer the CLI wrapped in its own update notice ("New version 1.3.5 available…",
 * appended after every command). The notice line is dropped, then the JSON is parsed as it stands, so both the
 * array and the `{ devices: [...] }` shapes survive; anything else throws exactly as `JSON.parse` would.
 */
const jsonFrom = (output: string) => {
  const text = output.replace(/^.*New version .*available.*$/gm, '').trim()
  const start = text.search(/[[{]/)
  const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'))
  return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text)
}
/**
 * The HTTP API behind the panel: toolchain, emulator, device, project, lint and deploy methods,
 * plus the background the model tools read through. Nothing here touches a model tool schema.
 */
/** A boolean parameter as prompts and scripts send it: a real boolean, or its word. */
function asBool(value: unknown): boolean {
  return value === true || value === 'true'
}
/** How long a version check may take in total: a probe plus a registry lookup, both under one cap. */
const PLAN_BUDGET_MS = 25000
/**
 * The emulator controls the panel offers: one entry each, nothing to type in. The controls that take
 * values (battery, geolocation, sensor) are deliberately absent — a dropdown cannot fill arguments.
 */
const EMU_CONTROLS = ['rotate', 'power', 'volume']
/** The panel's 当前时间 value: the smallest start the CLI accepts (`--from 0` is rejected). */
const NOW_LOG_FROM = '1s'
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
    if (!asBool(payload?.refresh) && toolchainCache !== null && Date.now() - toolchainCache.at < TOOLCHAIN_TTL_MS) {
      return toolchainCache.value
    }
    // SDK root comes from the environment only: this value is reported to the panel, and hdc is
    // resolved from the same variable, so a row-config override could only report a path that
    // discovery does not actually use.
    const sdk = process.env.DEVECO_SDK_HOME || ''
    const cliPath = resolveDevecoCli()
    // Local devecocli version (shown in the panel; helps spot an outdated CLI). Read by shape, the same
    // way the upgrade plan reads the registry answer: both go through one merged output buffer, and a
    // version is a bare `x.y.z` in it, never simply the first line.
    let cliVersion = null
    if (cliPath) {
      const v = await runCli([process.execPath, cliPath, '--version'], { timeoutMs: 20000 })
      if (v.code === 0) cliVersion = versionFromOutput(v.output) || null
    }
    // Signing materials can only be generated while an account is signed in, and the CLI's own failure text
    // does not say so. One read here answers it for the panel, and `hmos_setup`'s sign attaches the same
    // answer where it matters most. Null when there is no CLI to ask.
    let signedIn: boolean | null = null
    if (cliPath) {
      // A read that fails outright is not a reading: the row then says "状态未知" rather than "未登录", because
      // a machine whose `auth status` cannot run must not be made to look signed out.
      const who = await authStatus(cliPath)
      signedIn = who.known ? who.signedIn : null
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
      // The line an upgrade would follow; the panel labels the update action with it.
      devecoCliChannel: cliPath ? cliChannel(cliVersion) : null,
      // Whether an account is signed in: the panel shows it beside the CLI version, because `sign` cannot
      // write signing materials without one.
      signedIn,
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

  api['deveco.plan'] = async (payload, _res, ctl) => {
    // What an update would install, resolved before anything is touched: the channel, the spec, and
    // the build that channel points at right now. The target comes from the registry, so a failed
    // lookup is reported as unknown instead of assumed.
    //
    // One budget covers both steps: the user is waiting on this answer while a button says "检查中…",
    // so it must not sit for the sum of two child processes' timeouts.
    const deadline = Date.now() + PLAN_BUDGET_MS
    const left = (): number => Math.max(1000, deadline - Date.now())
    const cli = resolveDevecoCli()
    let installed = ''
    if (cli) {
      const probe = await runCli([process.execPath, cli, '--version'], { timeoutMs: left(), signal: ctl?.signal })
      // Read by shape, not by line: this goes through the same merged buffer npm does, and the two
      // sides of the comparison the panel makes have to be normalised the same way to be comparable.
      if (probe.code === 0) installed = versionFromOutput(probe.output)
    }
    const channel = cliUpdateChannel(installed, payload?.channel)
    const spec = cliInstallSpec(channel)
    const { file, args } = npmCommand(['view', spec, 'version'])
    const view = await runCli([file, ...args], { timeoutMs: left(), signal: ctl?.signal })
    const target = view.code === 0 ? versionFromOutput(view.output) : ''
    return { channel, spec, installed: installed || null, target: target || null, checked: target !== '' }
  }

  api['deveco.update'] = async (payload, _res, ctl) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    // Upgrade on the channel the panel asked for, falling back to the one the installed build came
    // from. `devecocli update` takes no channel argument (its help reads "update deveco-cli to
    // latest"), so an explicit dist-tag through npm is the only way to keep — or deliberately
    // leave — the stable line.
    const probe = await runCli([process.execPath, cli, '--version'], { timeoutMs: 20000, signal: ctl?.signal })
    const installed = probe.code === 0 ? (probe.output.trim().split(/\r?\n/)[0] || '') : ''
    const channel = cliUpdateChannel(installed, payload?.channel)
    const spec = cliInstallSpec(channel)
    const { file, args } = npmInvocation(spec)
    const result = await runCli([file, ...args], { timeoutMs: 240000, signal: ctl?.signal })
    return {
      code: result.code,
      timedOut: result.timedOut,
      output: result.output,
      channel,
      spec,
      note: result.code === 0
        ? `已按 ${channel} 通道更新(${spec});若宿主端路径变化,建议重启 dsh web。`
        : '更新失败,请查看输出(可能是 npm 源/网络问题)。',
    }
  }

  api['deveco.install'] = async () => {
    // Install @deveco/deveco-cli globally (CLI only; hdc/emulator still need the DevEco SDK). A fresh
    // install has no channel to follow, so it takes npm's default tag — named explicitly.
    const spec = cliInstallSpec('latest')
    const { file, args } = npmInvocation(spec)
    const result = await runCli([file, ...args], { timeoutMs: 240000 })
    return {
      code: result.code,
      timedOut: result.timedOut,
      output: result.output,
      spec,
      note: result.code === 0
        ? `devecocli 安装完成(${spec}),请重启 dsh web 生效;hdc 仍需安装 DevEco Studio SDK 并设置 DEVECO_SDK_HOME。`
        : '安装失败,请查看输出;也可能是 npm 源/权限问题。',
    }
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

  /**
   * The emulator controls that need nothing typed in: rotate, power and volume. They are the three the
   * panel can put behind one dropdown and one button, and the argv is the model tool's byte for byte —
   * the spec asserts it, which is what keeps the two in step without sharing code. The controls that
   * take values (battery, geolocation, sensor) stay with the tool, where their arguments can be filled.
   */
  api['emu.control'] = async (payload, _res, ctl) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const action = String(payload?.action || '')
    if (!EMU_CONTROLS.includes(action)) {
      throw Object.assign(new Error(`不支持的控制动作:${action || '(空)'}`), { code: 'bad-request' })
    }
    const target = typeof payload?.target === 'string' && payload.target.trim() ? payload.target.trim() : null
    if (!target) throw Object.assign(new Error('缺少模拟器实例名(先执行“列出模拟器”查看实例名)'), { code: 'bad-request' })
    const argv = ['emulator', action, '--target', target]
    if (action !== 'power') {
      const direction = String(payload?.direction || '')
      const allowed = action === 'rotate' ? ['left', 'right'] : ['up', 'down']
      // The CLI narrows each verb to its own two choices; saying so here answers with the wording the
      // panel shows, instead of a refusal that only makes sense after reading the CLI's own help.
      if (!allowed.includes(direction)) {
        throw Object.assign(new Error(`${action === 'rotate' ? '旋转' : '音量'}只支持 ${allowed.join(' 或 ')}`), { code: 'bad-request' })
      }
      argv.push(direction)
    }
    const result = await runCli([process.execPath, cli, ...argv], { timeoutMs: 60000, signal: ctl?.signal })
    return { code: result.code, timedOut: result.timedOut, aborted: result.aborted, action, target, output: result.output }
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
          const arr = jsonFrom(result.output)
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
    // Three panel intents share this route: clean (no device, no module), build only, and the full
    // run. Only the run needs a device, so only the run takes the pre-check and the device argument.
    const mode = payload?.mode === 'clean' ? 'clean'
      : payload?.mode === 'skipbuild' || asBool(payload?.skipBuild) ? 'skipbuild'
        : asBool(payload?.buildOnly) ? 'build' : 'run'
    // The device is required by the two modes that reach one, and by them alone: the mode is decided
    // first so that clean and build are never blocked by a device they do not use.
    if ((mode === 'run' || mode === 'skipbuild') && !device) {
      throw Object.assign(new Error('请先“刷新设备”并选择一个模拟器设备'), { code: 'bad-request' })
    }
    // Pre-check that the device is online (cross-platform) before a build that takes minutes. The two
    // modes that reach a device need it; the two that never touch one must not be blocked by it.
    if ((mode === 'run' || mode === 'skipbuild') && cli) {
      const probe = await runCli([process.execPath, cli, 'device', 'list', '--format', 'json'], { timeoutMs: 15000, signal: ctl?.signal })
      let online = false
      if (probe.code === 0) {
        try {
          const arr = jsonFrom(probe.output)
          online = Array.isArray(arr) && arr.some((d) => { const s = typeof d === 'string' ? d : (d && (d.serial || d.name)); return s === device })
        } catch { /* parse failed: skip the precheck and let run report it */ }
      }
      if (!online) {
        throw Object.assign(new Error(`设备 ${device} 当前未在线——请先点“启动”模拟器(或连接设备),再点“扫描可用”后重试`), { code: 'device-offline' })
      }
    }
    // Multi-module: choose --module (entry when present, else the first module). The panel may also
    // narrow a build to several modules; the single `module` stays for callers written before it.
    const modules = readModules(project)
    const asked = Array.isArray(payload?.modules) ? payload.modules.map((m) => String(m)).filter(Boolean) : []
    // A panel that switched project can still be holding the previous project's module names, so a
    // name this project does not have is refused instead of being handed to the build. An unreadable
    // module list (no marker, or JSON5 the reader does not cover) cannot judge them, so it does not.
    // A name this project does not have is refused instead of being handed to the build; a `module@target`
    // spec counts as the module it names, which is the form the CLI documents for targeting a build.
    const unknown = modules.length ? asked.filter((m) => !modules.includes(moduleName(m))) : []
    if (unknown.length) {
      throw Object.assign(new Error(`模块“${unknown.join('、')}”不属于该工程(可选:${modules.join('、')})`), { code: 'bad-request' })
    }
    if (modules.length && payload?.module !== undefined && payload?.module !== null && !modules.includes(moduleName(String(payload.module)))) {
      throw Object.assign(new Error(`模块“${payload.module}”不属于该工程(可选:${modules.join('、') || '无'})`), { code: 'bad-request' })
    }
    const chosen = asked[0] ?? (payload?.module ? String(payload.module) : modules.includes('entry') ? 'entry' : modules[0])
    // The panel and the model tools share these three: release is the mode a build ships in, `ability`
    // picks what the launch starts, and `uninstall` is the fix for an install that refuses to replace.
    const buildMode = payload?.buildMode === 'release' ? ['--build-mode', 'release'] : []
    const ability = typeof payload?.ability === 'string' && payload.ability.trim() ? ['--ability', payload.ability.trim()] : []
    const uninstall = asBool(payload?.uninstall) ? ['--uninstall'] : []
    const cmd = mode === 'clean'
      ? [process.execPath, cli, 'build', 'clean']
      : mode === 'build'
        ? [process.execPath, cli, 'build', ...buildMode, ...(asked.length ? ['--modules', ...asked] : chosen ? ['--modules', chosen] : [])]
        : [process.execPath, cli, 'run', '--device', device ?? '', ...(chosen ? ['--module', chosen] : []), ...buildMode, ...ability, ...uninstall, ...(mode === 'skipbuild' ? ['--skip-build'] : [])]
    // A log line is a record, so the run says where it deployed; build and clean have no device to name.
    const what = mode === 'clean'
      ? '清理构建'
      : mode === 'build'
        ? `构建${chosen ? `(模块 ${chosen})` : ''}`
        : `${mode === 'skipbuild' ? '部署(不构建)' : '构建并部署'}到 ${device}${chosen ? `(模块 ${chosen})` : ''}`
    const note = (code: number | null) => code === 0
      ? (mode === 'run'
        ? '构建、安装、启动完成。(hvigor 的 “No signingConfigs” 只是警告,模拟器可装未签名 debug 包)'
        : mode === 'skipbuild'
          ? '安装、启动完成,未重新构建。'
          : mode === 'build' ? '构建完成,未安装到设备。' : '构建产物已清理。')      : `${mode === 'clean' ? '清理' : mode === 'skipbuild' ? '部署' : '构建'}失败,请查看上方输出${mode === 'run' || mode === 'skipbuild' ? ';常见原因:签名未配置 / 设备未就绪' : ''}。`
    // Streaming: push to res as the command runs (live panel log).
    // cache-control must include no-transform: DSH webServer enables gzip (compression
    // middleware), which proxies chunked text/plain through zlib without flushing, so logs
    // would only arrive at the end (non-realtime). no-transform is the standard exemption
    // that keeps the response identity and line-by-line.
    if (res && typeof res.write === 'function') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache, no-transform' })
      res.write(`[dsh-hmos-emulator] ${what}\n`)
      const { code, aborted } = await runCliStream(cmd, {
        cwd: project,
        timeoutMs: 20 * 60 * 1000,
        signal: ctl?.signal,
        onChunk: (chunk) => { try { res.write(chunk) } catch { /* client disconnected */ } },
      })
      // -2 is the route's "did not finish" marker; the panel renders it as such either way.
      writeTail(res,
        `\n${aborted ? `已取消:${mode === 'run' || mode === 'skipbuild' ? '进程已终止,设备已释放。' : '进程已终止。'}` : note(code)}\n`,
        `[HMOS_EXIT]=${aborted ? -2 : code ?? -1}\n`)
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

  /**
   * One device log snapshot for the panel — the command the model tool runs, with the same flags, so
   * both sides read a device the same way. A snapshot returns, which is what makes it safe to run from
   * a request; following a log is a different thing and does not belong here. The spec asserts the
   * argv, which is what keeps this in step with tools/log.ts without the two sharing code.
   */
  api['log.snapshot'] = async (payload) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未检测到 devecocli,请先在设置中指定入口'), { code: 'no-cli' })
    const device = typeof payload?.device === 'string' && payload.device.trim() ? payload.device.trim() : await firstRunningSerial(cli)
    if (!device) throw Object.assign(new Error('尚无运行中的模拟器,请先启动一个实例'), { code: 'device-offline' })
    const tail = Number.isFinite(Number(payload?.tail)) ? Math.max(1, Math.min(500, Number(payload.tail))) : 50
    // 起始时间 picks the window. 当前时间 (the smallest start the CLI accepts, since `--from 0` is rejected)
    // means the latest lines with no window at all: sending `--from 1s` returns nothing when that second was
    // quiet, and a snapshot is asked for exactly because something is on screen. Any other value is a real
    // window, and `--tail` takes the newest N of it.
    const from = typeof payload?.from === 'string' ? payload.from.trim() : ''
    const argv = ['log', '--device', device, '--tail', String(tail)]
    if (typeof payload?.level === 'string' && payload.level) argv.push('--level', String(payload.level))
    if (typeof payload?.bundle === 'string' && payload.bundle.trim()) argv.push('--bundle-name', payload.bundle.trim())
    if (typeof payload?.keyword === 'string' && payload.keyword.trim()) argv.push('--keyword', payload.keyword.trim())
    // `from` is an offset back from now ("5m", "30s", "120"), not a clock time; the model tool calls it
    // `since` and the CLI flag is `--from`.
    if (from && from !== NOW_LOG_FROM) argv.push('--from', from)
    // No signal: a snapshot is capped at a minute by the CLI's own timeout, and the panel is the only
    // caller, so there is nothing here that a cancelled turn needs to interrupt.
    const r = await runCli([process.execPath, cli, ...argv], { timeoutMs: 60000 })
    return { code: r.code, output: r.output, device, tail, timedOut: r.timedOut === true }
  }

  /**
   * Follow a device log until the panel stops asking. This is the one method that never ends on its
   * own, so its lifetime belongs to the caller: the panel aborts its fetch, the request closes, and the
   * route's cancellation signal kills the CLI. A cap sits underneath, because a forgotten tab must not
   * leave a log-producing process running all day.
   */
  /**
   * The closing lines of a streamed route. A client that has already gone away destroys the response, and
   * writing to a destroyed one raises an error on it — unhandled, that escapes the route instead of ending
   * it quietly. Streaming routes hand their last lines to this instead of touching `res` directly.
   */
  function writeTail(res: any, ...chunks: string[]): void {
    try {
      if (res.writableEnded || res.destroyed) return
      for (const chunk of chunks) res.write(chunk)
      res.end()
    } catch { /* the client is gone; there is nobody left to tell */ }
  }

  api['log.follow'] = async (payload, res, ctl) => {
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未检测到 devecocli,请先在设置中指定入口'), { code: 'no-cli' })
    const device = typeof payload?.device === 'string' && payload.device.trim() ? payload.device.trim() : await firstRunningSerial(cli)
    if (!device) throw Object.assign(new Error('尚无运行中的模拟器,请先启动一个实例'), { code: 'device-offline' })
    if (!res || typeof res.write !== 'function') {
      throw Object.assign(new Error('日志监听需要流式响应'), { code: 'bad-request' })
    }
    const argv = ['log', '--device', device, '--follow']
    if (typeof payload?.level === 'string' && payload.level) argv.push('--level', String(payload.level))
    if (typeof payload?.bundle === 'string' && payload.bundle.trim()) argv.push('--bundle-name', payload.bundle.trim())
    if (typeof payload?.keyword === 'string' && payload.keyword.trim()) argv.push('--keyword', payload.keyword.trim())
    // A live follow takes the same narrowing as a snapshot, so the panel's filter row means one thing
    // for both buttons. `--from` is accepted here too (it emits the recent tail before following).
    if (typeof payload?.from === 'string' && payload.from.trim()) argv.push('--from', payload.from.trim())
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache, no-transform' })
    res.write(`[dsh-hmos-emulator] 实时监听 ${device} 的日志(最长 30 分钟)\n`)
    const { code, aborted, timedOut } = await runCliStream([process.execPath, cli, ...argv], {
      timeoutMs: 30 * 60 * 1000,
      signal: ctl?.signal,
      onChunk: (chunk) => { try { res.write(chunk) } catch { /* client disconnected */ } },
    })
    // The cap is a third outcome: reported as an ordinary end it looks exactly like the device dropping the
    // stream, and the reader has no way to know the follow was cut short rather than finished.
    writeTail(res,
      `\n${aborted ? '已停止监听。' : timedOut ? '已达 30 分钟上限,监听已停止。' : `监听结束(退出码 ${code ?? '未知'})。`}\n`,
      `[HMOS_EXIT]=${aborted ? -2 : code ?? -1}\n`)
  }

  /**
   * Save the panel's own log box to a file. The panel holds the lines — they arrived as streamed CLI
   * output — so this route is only the writer: the folder arrives with the request (the panel picked it),
   * the name carries the device and the moment, and the colours are already gone by the time it gets here.
   */
  api['log.export'] = async (payload) => {
    const dir = typeof payload?.dir === 'string' && payload.dir.trim() ? payload.dir.trim() : null
    if (!dir || !existsSync(dir)) throw Object.assign(new Error('缺少保存文件夹(导出时选择)'), { code: 'bad-request' })
    const text = typeof payload?.text === 'string' ? payload.text : ''
    if (!text.trim()) throw Object.assign(new Error('面板暂无日志可导出'), { code: 'bad-request' })
    const device = typeof payload?.device === 'string' && payload.device.trim() ? payload.device.trim() : ''
    const safe = device.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24)
    const file = join(dir, `hmos-log-${Date.now()}${safe ? `-${safe}` : ''}.log`)
    try { writeFileSync(file, text, 'utf8') } catch (error) {
      throw Object.assign(new Error(`写入日志失败:${error instanceof Error ? error.message : String(error)}`), { code: 'fs-error' })
    }
    return { path: file, bytes: Buffer.byteLength(text, 'utf8') }
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
        const arr = jsonFrom(probe.output)
        devices = (Array.isArray(arr) ? arr : [])
          .map((d) => (typeof d === 'string' ? d : (d && (d.serial || d.name))))
          .filter((s) => typeof s === 'string' && /^[\w.:-]+$/.test(s))
        online = devices.includes(serial)
      } catch { /* parse failed: treat as offline */ }
    }
    return { online, serial, devices }
  }

  /**
   * One file transfer for the panel — the command the model tool builds, so the human and the model
   * move a file the same way. `send` uploads one local file, `recv` pulls one back; a local path that
   * is not absolute is read against the workspace, which is what lets "save it into the workspace" be
   * a plain name. Both argvs are asserted by the spec, as they are for the other shared commands.
   */
  api['device.file'] = async (payload) => {
    const direction = String(payload?.direction || '')
    // The direction decides which command this is, so an unknown one is answered before anything is
    // probed: a device lookup that ran first would report "no device" to a caller whose mistake was
    // the direction, and it would cost a spawn on every such call.
    if (direction !== 'send' && direction !== 'recv') {
      throw Object.assign(new Error(`不支持的文件方向:${direction || '(空)'}`), { code: 'bad-request' })
    }
    const cli = resolveDevecoCli()
    if (!cli) throw Object.assign(new Error('未找到 devecocli(见工具链提示)'), { code: 'toolchain' })
    const device = typeof payload?.device === 'string' && payload.device.trim() ? payload.device.trim() : null
    if (!device) throw Object.assign(new Error('缺少目标设备串号(先在“设备操作”选择在线设备)'), { code: 'bad-request' })
    const remote = typeof payload?.remote === 'string' ? payload.remote.trim() : ''
    const asked = typeof payload?.local === 'string' ? payload.local.trim() : ''
    if (!remote) throw Object.assign(new Error('缺少设备上的路径'), { code: 'bad-request' })
    if (!asked) throw Object.assign(new Error(direction === 'send' ? '缺少要发送的本地文件' : '缺少保存位置'), { code: 'bad-request' })
    const root = typeof payload?.root === 'string' && payload.root.trim() ? payload.root.trim() : ''
    // Only a relative local path needs the workspace; an absolute one is its own answer.
    if (!absoluteLocal(asked) && !root) {
      throw Object.assign(new Error('缺少工作区根目录(相对路径需要它)'), { code: 'bad-request' })
    }
    const local = localPathFor(asked, root || process.cwd())
    // Uploading a path that is not there is worth saying before a device round trip; a download into a
    // directory that does not exist yet is not the caller's problem to solve.
    if (direction === 'send') {
      const stat = existsSync(local) ? statSync(local) : null
      if (!stat) throw Object.assign(new Error(`本地文件不存在:${local}`), { code: 'bad-request' })
      // The panel's own chooser picks directories only, so handing one in is the easy mistake to make.
      if (stat.isDirectory()) throw Object.assign(new Error(`本地路径是个文件夹,请补上文件名:${local}`), { code: 'bad-request' })
    }
    if (direction === 'recv') {
      // Wrapped: an unreadable parent (a wrong drive, a path under a file) is the caller's mistake and must
      // come back as a readable 400, not an untagged filesystem throw that the transport turns into a 500.
      const parent = dirname(local)
      try { mkdirSync(parent, { recursive: true }) } catch (error) {
        throw Object.assign(new Error(`无法创建保存目录 ${parent}:${error instanceof Error ? error.message : String(error)}`), { code: 'fs-error' })
      }
    }
    const argv = direction === 'send'
      ? ['device', 'file', 'send', '--device', device, local, remote]
      : ['device', 'file', 'recv', '--device', device, remote, local]
    const r = await runCli([process.execPath, cli, ...argv], { timeoutMs: 5 * 60 * 1000 })
    if (r.code !== 0) {
      const why = r.timedOut ? '超时' : `退出码 ${r.code}`
      throw Object.assign(new Error(`传输失败(${why}):\n${tailText(r.output, 6)}`), { code: 'transfer-failed' })
    }
    return { direction, device, local, remote, output: r.output }
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
    const auto = asBool(payload?.auto)
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

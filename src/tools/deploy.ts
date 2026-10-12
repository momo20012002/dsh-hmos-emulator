import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { deployPhase, pageMissingHint, parseBuildErrors, stripAnsi } from '../parsers/devecocli.js'
import { firstRunningSerial, resolveDevecoCli, runCli, throwIfAborted } from '../toolchain.js'
import { PROJECT_MARK, hapPathOf, projectRootOf, readModules, relativeTo, sessionWorkspace } from '../workspace.js'
import { tailText } from '../text.js'
import { TOOL_OUT_SCHEMA, shotFields, toolRender } from '../shots.js'
import { PROJECT_ROOT } from './schema.js'
import type { ToolDeps } from './deps.js'
/** Build and install a project on the emulator. */

/** A boolean parameter as prompts and scripts send it: a real boolean, or its word. */
function asBool(value: unknown): boolean {
  return value === true || value === 'true'
}

/** Trimmed string, or empty. */
const asTextArg = (value: unknown): string => (typeof value === 'string' && value.trim() ? value.trim() : '')

export function makeHmosDeploy(deps: ToolDeps) {
  const { api, ctx } = deps
  return {
      name: 'hmos_deploy',
      description: 'Build and deploy a project via devecocli: deploy builds -> installs -> launches, clean runs hvigor clean. buildOnly builds without a device; modules narrows a build; buildMode picks debug or release; on a deploy, ability names the ability to launch and uninstall removes the installed app first. Returns phase, duration, ArkTS errors with file/line, hap path and a tail.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['deploy', 'clean'], description: 'deploy (default) | clean (hvigor clean; no device needed)' },
          projectPath: PROJECT_ROOT,
          device: { type: 'string', description: 'serial (default: first running emulator)' },
          modules: { type: 'array', items: { type: 'string' }, description: 'modules to build (default: the entry). A full deploy takes one; use buildOnly for several.' },
          buildOnly: { type: 'boolean', description: 'build only: no device, no install/launch' },
          skipBuild: { type: 'boolean', description: 'run --skip-build: install + launch existing artifacts' },
          buildMode: { type: 'string', enum: ['debug', 'release'], description: '--build-mode (default: debug). release builds what you ship.' },
          ability: { type: 'string', description: 'deploy: the ability to launch (--ability)' },
          uninstall: { type: 'boolean', description: 'deploy: uninstall the installed app first (--uninstall)' },
          read: { type: 'boolean', description: 'attach the failure screenshot when the deploy fails, not just its path' },
        },
        required: ['projectPath'],
      },
      output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
      async execute(args, exec) {
        throwIfAborted(exec?.signal)
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
        // `clean` answers the one build failure whose fix is not in the code: stale outputs. It needs
        // no device and no module, so it returns before either is resolved.
        const action = typeof args?.action === 'string' && args.action.trim() ? args.action.trim() : 'deploy'
        if (action !== 'deploy' && action !== 'clean') {
          // A misspelt action must not fall through to a real build and install.
          return { ok: false, error: `unknown action ${action}; expected deploy or clean` }
        }
        // Two intents that cannot both be served. The note says which one ran, so a caller that sent
        // both learns the other was ignored instead of assuming both happened.
        const conflictNote = action === 'clean' && asBool(args?.buildOnly) ? '本次按 action=clean 执行,忽略了 buildOnly。' : ''
        // `--build-mode` is only passed when release was asked for: debug is the CLI's own default, and
        // spelling it out would change the argv every existing caller already sends.
        const askedMode = typeof args?.buildMode === 'string' && args.buildMode.trim() ? args.buildMode.trim() : 'debug'
        if (askedMode !== 'debug' && askedMode !== 'release') {
          return { ok: false, error: `buildMode takes debug or release, not ${askedMode}` }
        }
        const release = askedMode === 'release' ? ['--build-mode', 'release'] : []
        if (action === 'clean') {
          const started = Date.now()
          const r = await runCli([process.execPath, cli, 'build', 'clean'], { cwd: projectPath, timeoutMs: 10 * 60 * 1000, signal: exec?.signal })
          const text = stripAnsi(r.output)
          return {
            ok: r.code === 0,
            code: r.code,
            timedOut: r.timedOut === true,
            phase: 'clean',
            durationMs: Date.now() - started,
            tail: tailText(text, r.code === 0 ? 4 : 12),
            error: r.code === 0 ? '' : tailText(text, 8),
            ...(conflictNote ? { note: conflictNote } : {}),
          }
        }
        const buildOnly = asBool(args?.buildOnly)
        const skipBuild = asBool(args?.skipBuild)
        const device = buildOnly
          ? ''
          : (typeof args?.device === 'string' && args.device.trim() ? args.device.trim() : '') || await firstRunningSerial(cli)
        if (!buildOnly && !device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' }
        const modules = readModules(projectPath)
        // `modules` is the declared parameter; the older single `module` still arrives from prompts and
        // scripts written before it, and the parameter root is open, so accept it rather than ignore a
        // request that used to work.
        // A string arrives from prompts that spell the list out; splitting it is what keeps a named
        // module from being dropped as "not an array" and the build falling back to the entry module.
        const rawList = Array.isArray(args?.modules) ? args.modules : typeof args?.modules === 'string' ? args.modules.split(/[,、]/) : []
        const listed = rawList.map((m) => String(m).trim()).filter(Boolean)
        const legacy = typeof args?.module === 'string' ? args.module.trim() : ''
        const askedList = listed.length ? listed : (legacy ? [legacy] : [])
        const asked = askedList.join('、')
        // The marker file is checked to exist above, so an empty list means the names could not be
        // READ (an extreme JSON5 literal `stripJson5` does not cover). Rejecting an explicit
        // module with "模块 X 不属于该工程(可选:无)" was a misleading answer to a readable request:
        // pass it through to hvigor instead, and say the list was unreadable.
        const modulesUnreadable = modules.length === 0
        const unknown = modulesUnreadable ? [] : askedList.filter((m) => !modules.includes(m))
        if (unknown.length) {
          return { ok: false, error: `模块“${unknown.join('、')}”不属于该工程(可选:${modules.join('、')})` }
        }
        // One module drives the run path and the HTTP deploy path; a build-only call may take several.
        const chosenList = askedList.length ? askedList : (modules.includes('entry') ? ['entry'] : modules.slice(0, 1))
        const chosen = chosenList[0] ?? ''
        const unreadNote = modulesUnreadable
          ? `未能从 build-profile.json5 读出模块名(stripJson5 只覆盖常见 JSON5 写法),本次${asked ? `按你指定的 modules=“${asked}”` : '不传 --modules'};要精确定位请显式传 modules。`
          : ''
        // Two module names were given two ways: `modules` wins, and the older one is said to be
        // ignored rather than dropped in silence.
        const legacyNote = listed.length && legacy ? `本次以 modules=${listed.join('、')} 为准,忽略 module=“${legacy}”。` : ''
        const narrowedNote = chosenList.length > 1 && !skipBuild
          ? (buildOnly
            ? ''
            : `本次 deploy 只构建第一个模块(${chosen});要一次构建多个模块请用 buildOnly=true。`)
          : ''
        const givenNote = chosenList.length > 1 && skipBuild
          ? `安装与启动只涉及第一个模块(${chosen})。`
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
              ? [process.execPath, cli, 'build', ...release, ...(chosenList.length ? ['--modules', ...chosenList] : [])]
              : [process.execPath, cli, 'run', '--device', device, ...(chosen ? ['--module', chosen] : []), ...release, ...(asTextArg(args?.ability) ? ['--ability', asTextArg(args?.ability)] : []), ...(asBool(args?.uninstall) ? ['--uninstall'] : []), '--skip-build']
            const r = await runCli(argv, { cwd: projectPath, timeoutMs: 20 * 60 * 1000, signal: exec?.signal })
            output = r.output
            code = r.code
            timedOut = r.timedOut
          } else {
            // Reuse the HTTP API's non-streaming path: it already validates the project, checks the
            // device is online and picks the entry module.
            const r = await api.deploy({
              projectPath, device, module: chosen,
              ...(release.length ? { buildMode: 'release' } : {}),
              ...(asTextArg(args?.ability) ? { ability: asTextArg(args?.ability) } : {}),
              ...(asBool(args?.uninstall) ? { uninstall: true } : {}),
            }, undefined, { signal: exec?.signal })
            output = String(r.output || '')
            code = r.code ?? null
            timedOut = r.timedOut === true
            note = r.note
          }
        } catch (error) {
          const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'internal'
          return { ok: false, device, phase: 'build', durationMs: Date.now() - started, errorCode, error: error instanceof Error ? error.message : String(error) }
        }
        // Colour frames and `\r` redraws are noise once the output is a tool result: strip them
        // before both the error parse and the tail see it.
        output = stripAnsi(output)
        const { errors, errorCount, warnCount } = parseBuildErrors(output)
        const ok = code === 0
        const result: any = {
          ok,
          code,
          timedOut,
          device: device || null,
          module: chosen || null,
          modules: chosenList,
          // Echoed because the two branches above are invisible to the caller: a release build and a debug
          // one used to come back identical, so "did my --build-mode reach the CLI?" had no answer.
          buildMode: release.length ? 'release' : 'debug',
          ...(asTextArg(args?.ability) ? { ability: asTextArg(args?.ability) } : {}),
          ...(asBool(args?.uninstall) ? { uninstall: true } : {}),
          phase: buildOnly ? 'build' : deployPhase(output),
          durationMs: Date.now() - started,
          errors: errors.map((e) => ({ ...e, file: relativeTo(projectPath, e.file) })),
          errorCount,
          warnCount,
        }
        const hap = chosen ? hapPathOf(projectPath, chosen) : null
        // Only a build that succeeded produced the artifact this call names. A failure leaves the
        // previous build's hap in the standard output directory, so reporting that path would read as
        // "this call produced that file".
        if (ok && hap) result.hapPath = hap
        if (!ok && note) result.note = note
        // A failed build can end at the entry-list check, whose message hides the page's own
        // diagnostics; say so next to it rather than letting it read as the real error.
        if (!ok) {
          const masked = pageMissingHint(output)
          if (masked) result.note = result.note ? `${result.note} ${masked}` : masked
        }
        // A readable-looking project whose module list could not be parsed is worth saying out loud,
        // on success too: the caller cannot otherwise tell why `--modules` was or was not passed.
        if (unreadNote) result.note = result.note ? `${result.note} ${unreadNote}` : unreadNote
        if (legacyNote) result.note = result.note ? `${result.note} ${legacyNote}` : legacyNote
        if (narrowedNote) result.note = result.note ? `${result.note} ${narrowedNote}` : narrowedNote
        if (givenNote) result.note = result.note ? `${result.note} ${givenNote}` : givenNote
        result.tail = tailText(output, ok ? 6 : 30)
        // Both failure paths of this tool carry `error`, so a caller that reads only that field sees
        // the same thing whether the build failed or `clean` did.
        if (!ok) result.error = tailText(output, 8)
        // A failed install/launch leaves the device showing whatever the app did — the one thing the
        // build log cannot tell. A build-only failure has nothing to look at.
        if (!ok && !buildOnly && device) {
          Object.assign(result, await shotFields(api, device, sessionWorkspace(exec), `deploy-${deployPhase(output)}`, ctx, asBool(args?.read)))
        }
        return result
      },
  }
}

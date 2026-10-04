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

export function makeHmosDeploy(deps: ToolDeps) {
  const { api, ctx } = deps
  return {
      name: 'hmos_deploy',
      description: 'Build and deploy a project via devecocli (run: build -> install -> launch; buildOnly: build only). Returns phase, duration, ArkTS errors with file/line, hap path and an output tail.',
      parameters: {
        type: 'object',
        properties: {
          projectPath: PROJECT_ROOT,
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
            const r = await runCli(argv, { cwd: projectPath, timeoutMs: 20 * 60 * 1000, signal: exec?.signal })
            output = r.output
            code = r.code
            timedOut = r.timedOut
          } else {
            // Reuse the HTTP API's non-streaming path: it already validates the project, checks the
            // device is online and picks the entry module.
            const r = await api.deploy({ projectPath, device, module: chosen }, undefined, { signal: exec?.signal })
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
          phase: buildOnly ? 'build' : deployPhase(output),
          durationMs: Date.now() - started,
          errors: errors.map((e) => ({ ...e, file: relativeTo(projectPath, e.file) })),
          errorCount,
          warnCount,
        }
        const hap = chosen ? hapPathOf(projectPath, chosen) : null
        if (hap) result.hapPath = hap
        if (!ok && note) result.note = note
        // A failed build can end at the entry-list check, whose message hides the page's own
        // diagnostics; say so next to it rather than letting it read as the real error.
        if (!ok) {
          const masked = pageMissingHint(output)
          if (masked) result.note = result.note ? `${result.note} ${masked}` : masked
        }
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
}

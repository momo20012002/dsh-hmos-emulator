import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { codeStatusFiles, lintScope } from '../git.js'
import { lintOutcome, parseLintTable } from '../parsers/lint.js'
import { PROJECT_MARK, projectRootOf } from '../workspace.js'
import { resolveDevecoCli, runCli, throwIfAborted } from '../toolchain.js'
import { stripAnsi } from '../parsers/devecocli.js'
import { tailText } from '../text.js'
import { TOOL_OUT_SCHEMA, toolRender } from '../shots.js'
import { PROJECT_ROOT } from './schema.js'
import type { ToolDeps } from './deps.js'
/** DevEco code check over the changed or all files. */

/** A boolean parameter as prompts and scripts send it: a real boolean, or its word. */
function asBool(value: unknown): boolean {
  return value === true || value === 'true'
}

export function makeHmosLint(_deps: ToolDeps) {
  return {
      name: 'hmos_lint',
      description: 'Run DevEco code checks on a project. kind=lint (default) runs the Code Linter over the changed or all files and returns findings structured; a non-git project with scope=changed escalates to a full check, and new (untracked) files are reported because --incremental cannot see them. kind=arkts runs the ArkTS static check on .ets sources (fix:true auto-fixes high-confidence errors first). kind=compat checks the source against a target SDK version and needs sourceVersion and targetVersion; without them it answers with the versions the CLI accepts.',
      parameters: {
        type: 'object',
        properties: {
          projectPath: PROJECT_ROOT,
          kind: { type: 'string', enum: ['lint', 'arkts', 'compat'], description: 'lint (default) | arkts static check | compat against a target SDK' },
          fix: { type: 'boolean', description: 'lint / arkts: run the CLI\'s own fix pass first, which rewrites files' },
          sourceVersion: { type: 'string', description: 'compat: current project SDK version' },
          targetVersion: { type: 'string', description: 'compat: target SDK version to check against' },
          scope: { type: 'string', enum: ['changed', 'all'], description: 'lint: changed = --incremental (default); all = whole project' },
        },
        required: ['projectPath'],
      },
      output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
      async execute(args, exec) {
        throwIfAborted(exec?.signal)
        const cli = resolveDevecoCli()
        if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
        const project = projectRootOf(args?.projectPath, exec)
        if (!project) return { ok: false, error: 'projectPath is required' }
        if (!existsSync(project)) return { ok: false, error: `应用工程路径不存在:${project}` }
        if (!existsSync(join(project, PROJECT_MARK))) {
          return { ok: false, error: `未找到 ${PROJECT_MARK}:已按 ${project} 查找(传目录时请给工程根,相对路径按会话工作区解析)。` }
        }
        // An unknown `kind` used to fall through to the linter, which answered `ok:true` with a result no
        // caller could tell apart from a real lint run — and with `fix:true` it would have rewritten the
        // project's files first. Absent means lint; a value that is present must be one of the three.
        const askedKind = typeof args?.kind === 'string' && args.kind.trim() ? args.kind.trim() : 'lint'
        if (askedKind !== 'lint' && askedKind !== 'arkts' && askedKind !== 'compat') {
          return { ok: false, error: `kind takes lint, arkts or compat, not ${askedKind}` }
        }
        const kind = askedKind
        if (kind !== 'lint') {
          // The other two checks share this tool rather than tool #8: they answer the same question
          // ("is this project sound?") at a different angle, and a caller already holding this one
          // reaches them without discovering anything new.
          const started = Date.now()
          if (kind === 'arkts') {
            const argv = [process.execPath, cli, 'check', 'arkts', '--project', project, ...(asBool(args?.fix) ? ['--fix'] : [])]
            const r = await runCli(argv, { cwd: project, timeoutMs: 300000, signal: exec?.signal })
            const out = stripAnsi(r.output)
            return {
              ok: r.code === 0, kind, projectPath: project, code: r.code, timedOut: r.timedOut === true,
              durationMs: Date.now() - started, tail: tailText(out, r.code === 0 ? 6 : 30),
              ...(r.code === 0 ? {} : { error: tailText(out, 8) }),
            }
          }
          const sourceVersion = typeof args?.sourceVersion === 'string' ? args.sourceVersion.trim() : ''
          const targetVersion = typeof args?.targetVersion === 'string' ? args.targetVersion.trim() : ''
          if (!sourceVersion || !targetVersion) {
            // Which version strings are valid is knowable only from the CLI, so a call missing one is
            // answered with the list instead of a complaint about a missing argument.
            const listed = await runCli([process.execPath, cli, 'check', 'compat', 'versions'], { timeoutMs: 60000, signal: exec?.signal })
            return {
              ok: false, kind, projectPath: project,
              error: 'compat needs sourceVersion and targetVersion',
              versions: tailText(stripAnsi(listed.output), 30),
            }
          }
          const r = await runCli([process.execPath, cli, 'check', 'compat', '--source-version', sourceVersion, '--target-version', targetVersion], { cwd: project, timeoutMs: 300000, signal: exec?.signal })
          const out = stripAnsi(r.output)
          return {
            ok: r.code === 0, kind, projectPath: project, code: r.code, timedOut: r.timedOut === true,
            durationMs: Date.now() - started, sourceVersion, targetVersion,
            tail: tailText(out, r.code === 0 ? 8 : 30),
            ...(r.code === 0 ? {} : { error: tailText(out, 8) }),
          }
        }
        // Same shape as `kind`: absent means the default scope, and a value that is present but unknown is
        // refused here instead of quietly becoming `changed`.
        const askedScope = typeof args?.scope === 'string' && args.scope.trim() ? args.scope.trim() : 'changed'
        if (askedScope !== 'changed' && askedScope !== 'all') {
          return { ok: false, error: `scope takes changed or all, not ${askedScope}` }
        }
        let full = askedScope === 'all'
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
        // The linter's own repair pass, the same one the panel's "代码修复" runs. Asking for it here keeps
        // the tool and the panel on one surface instead of leaving the model to describe what the button does.
        if (asBool(args?.fix)) argv.push('--fix')
        if (!full) argv.push('--incremental')
        // cwd = project: codelinter prints File paths relative to the process cwd,
        // so this is what makes the returned paths project-relative instead of host-cwd-relative.
        const r = await runCli(argv, { cwd: project, timeoutMs: full ? 600000 : 300000, signal: exec?.signal })
        // Same toolchain, same colour frames as a build: the table parser and the raw tail both read
        // better without them.
        const out = stripAnsi(r.output)
        const { findings, summary } = parseLintTable(out)
        const bySeverity = (want: string) => findings.filter((f) => f.severity === want)
        const errors = bySeverity('Error')
        const warnings = bySeverity('Warning')
        const suggestions = bySeverity('Suggestion')
        const outcome = lintOutcome(summary, full ? 'all' : 'changed', checkedFiles ? checkedFiles.length : null)
        const cap = 40
        return {
          ok: errors.length === 0,
          kind: 'lint',
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
          rawTail: tailText(out, 2),
        }
      },
  }
}

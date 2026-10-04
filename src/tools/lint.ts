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

export function makeHmosLint(_deps: ToolDeps) {
  return {
      name: 'hmos_lint',
      description: 'Run the DevEco code check via devecocli check lint; findings come back structured. changed = uncommitted tracked files under the project, reported as checkedFiles (a non-git project escalates to a full check); new files come back as untrackedFiles (incremental cannot see them); all = whole project.',
      parameters: {
        type: 'object',
        properties: {
          projectPath: PROJECT_ROOT,
          scope: { type: 'string', enum: ['changed', 'all'], description: 'changed: --incremental (default) | all' },
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

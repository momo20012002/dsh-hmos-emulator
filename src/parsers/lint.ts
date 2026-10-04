/**
 * Parse codelinter output (`check lint`): findings table, summary line and the
 * scope/outcome vocabulary the hmos_lint tool reports.
 */
export interface LintSummary {
  issues: number
  errors: number
  warnings: number
  suggestions: number
  files: number
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
export const LINT_LABELS = { changed: '检查改动', all: '全量检查', fix: '自动修复', 'fix-all': '全量修复' }

/** Files codelinter may rewrite, and directories it never looks at. */
export const LINT_EXT = /\.(ets|ts|js|json5|json)$/
export const LINT_SKIP = /(^|[\\/])(node_modules|oh_modules|build|\.git|\.hvigor|\.idea|\.preview)([\\/]|$)/

/** How much a fix run rewrote, which is the only result its own output can be trusted for. */
export function fixStats(fixedFiles: number | null): string {
  if (fixedFiles === null) return '已执行自动修复(无法统计改动文件)'
  if (fixedFiles === 0) return '没有可自动修复的告警,未改动任何文件'
  return `已自动修复 ${fixedFiles} 个文件`
}

/** Parse codelinter's trailing summary line. */
export const LINT_SUMMARY_RE = /Issues:\s*(\d+)\s*\|\s*Errors:\s*(\d+)\s*\|\s*Warnings:\s*(\d+)\s*\|\s*Suggestions:\s*(\d+)\s*\|\s*Files checked:\s*(\d+)/
export function parseLintSummary(text: string): LintSummary | null {
  const m = String(text || '').match(LINT_SUMMARY_RE)
  return m
    ? { issues: Number(m[1]), errors: Number(m[2]), warnings: Number(m[3]), suggestions: Number(m[4]), files: Number(m[5]) }
    : null
}

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


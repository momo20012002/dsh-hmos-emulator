/**
 * Panel formatting. Everything here is pure and imports no React, so the rules the panel applies to
 * host answers — durations, paths, CLI lines, check wording — can be tested without a renderer.
 */
/** Panel-facing names of the four check modes, shared by the buttons and the status line. */
export const LINT_TITLES: Record<string, string> = { changed: '检查改动', all: '全量检查', fix: '自动修复', 'fix-all': '全量修复' }

/** Elapsed time of a running step: "42s" below a minute, "1m12s" above. */
export function fmtDur(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`
}

/** The last two path segments, so a long path fits the row; the full path stays in the title. */
export function shortPath(p: unknown): string {
  const parts = String(p).split(/[\\/]/)
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : String(p)
}

/** One line of build output as the log shows it: no ANSI colour, no CR, no trailing blanks. */
export function cleanCliLine(line: string): string {
  return String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '').replace(/\s+$/, '')
}

/** The exit code a streaming route reports as `[HMOS_EXIT]=<code>`, or null for any other line. */
export function exitCodeOf(line: string): number | null {
  return line.startsWith('[HMOS_EXIT]=') ? Number(line.slice(12)) : null
}

/** The check result line: the host's own wording when present, raw counts for an older host. */
export function lintStatusLine(value: any): string {
  const summary = value?.summary || {}
  return value?.stats
    || `错误 ${summary.errors ?? '-'}、警告 ${summary.warnings ?? '-'}、建议 ${summary.suggestions ?? '-'}、涉及文件 ${summary.files ?? '-'}`
}

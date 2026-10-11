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

/** One styled piece of a CLI line: the text, and the colour/weight the escape asked for. */
export interface AnsiRun {
  readonly text: string
  /** Absent means "the log's own colour"; the escape did not set one. */
  readonly color?: string
  readonly bold?: boolean
}

/**
 * SGR colours mapped to the panel's own vocabulary instead of raw ANSI hex, so a coloured CLI answer
 * stays readable in both themes: green/red reuse the panel's success/danger tokens, and the rest are
 * the classic ANSI hues.
 */
export const ANSI_PALETTE: Record<number, string> = {
  30: 'var(--dsw-alias-label-secondary, rgba(148,148,160,.9))',
  31: 'var(--dsw-alias-state-error-primary, #e5484d)',
  32: 'var(--dsw-alias-state-success-primary, #2f9e44)',
  33: '#d29922',
  34: '#4f6ef7',
  35: '#c678dd',
  36: '#2aa198',
  37: 'var(--dsw-alias-label-primary, #e6e6e6)',
  90: 'var(--dsw-alias-label-tertiary, rgba(148,148,160,.7))',
  91: '#ff7b72',
  92: '#3fb950',
  93: '#e3b341',
  94: '#79c0ff',
  95: '#d2a8ff',
  96: '#56d4dd',
  97: '#f0f6fc',
}

/**
 * A CSI sequence: parameter bytes, then intermediate bytes, then one final byte. `m` is SGR (styling);
 * the rest are dropped. The parameter class includes `?` and `>` because tools do emit private
 * sequences — a hidden cursor is `ESC [ ? 25 l` — and a matcher that only understood digits and
 * semicolons left those in the log as literal `[?25l` text.
 */
const ANSI_CSI = /\u001b\[([0-9;?<=>]*)([ -/]*)([@-~])/g

/**
 * Split one CLI line into styled runs, so the colours a tool prints are shown as colours.
 *
 * Every escape is consumed: an SGR code sets the colour/weight for the text after it, and any other
 * CSI (cursor moves, erases) is dropped rather than left in the text as a stray `[2K`.
 * @param text - one line of CLI output, escapes included.
 * @returns the runs to render, in order; empty input yields no runs.
 */
export function ansiRuns(text: unknown): AnsiRun[] {
  const source = String(text).replace(/\r/g, '')
  const runs: AnsiRun[] = []
  let color: string | undefined
  let bold = false
  let at = 0
  const push = (chunk: string): void => {
    if (chunk !== '') runs.push({ text: chunk, ...(color === undefined ? {} : { color }), ...(bold ? { bold: true } : {}) })
  }
  for (const match of source.matchAll(ANSI_CSI)) {
    push(source.slice(at, match.index ?? 0))
    at = (match.index ?? 0) + match[0].length
    // Group 3 is the final byte: only `m` carries styling, everything else is consumed and dropped.
    if (match[3] !== 'm') continue
    for (const code of (match[1] === '' ? '0' : match[1]).split(';')) {
      const value = Number(code === '' ? '0' : code)
      if (value === 0) { color = undefined; bold = false }
      else if (value === 39) color = undefined
      else if (value === 1) bold = true
      else if (value === 22) bold = false
      else if (ANSI_PALETTE[value] !== undefined) color = ANSI_PALETTE[value]
      // 38;5;n / 38;2;r;g;b are not emitted here; ignoring them beats mis-parsing the arguments.
    }
  }
  push(source.slice(at))
  return runs
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

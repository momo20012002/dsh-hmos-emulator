/**
 * Text helpers shared by tool results: heads, tails, line caps, slices and line diffs.
 * Pure string work - no I/O, no host state.
 */
/** Keep the first n non-empty lines (issue lists put entries before the summary). */
export function headText(text, n) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '')
  return lines.slice(0, n).join('\n')
}

/** Keep the last n non-empty lines (trims command output before it reaches context). */
export function tailText(text, n) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '')
  return lines.slice(-n).join('\n')
}

/**
 * Cap a rendered tree by LINE count, never by characters: a character cap slices a line in half and
 * leaves a fragment that reads like a node. The note names `depth` and `filter`, both real emu_ui
 * parameters.
 */
export function capLines(lines: string[], max = 80): string[] {
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), `…(还有 ${lines.length - max} 行未显示;可用 depth 或 filter 收窄)`]
}

/**
 * Multiset difference of two rendered trees: the lines that disappeared, then the lines that
 * appeared. This exists for the shape `0 / 3` → `1 / 3`, where the whole tree is noise and the one
 * changed line is the assertion; `changed:0` is the "nothing moved" answer the caller checks for.
 */
export function diffLines(before: string[], after: string[]): string {
  const counts = new Map<string, number>()
  for (const line of before) counts.set(line, (counts.get(line) ?? 0) + 1)
  const added: string[] = []
  for (const line of after) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added.push(line)
  }
  const removed: string[] = []
  for (const [line, left] of counts) for (let i = 0; i < left; i += 1) removed.push(line)
  if (added.length === 0 && removed.length === 0) return 'changed:0'
  return [...removed.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].join('\n')
}

/**
 * One slice of a long document, with the numbers a caller needs to page through it. Returns the
 * whole text when it already fits, and `nextOffset` only when there is more to read.
 */
export function sliceText(text: string, offset = 0, limit = 8000): { text: string; total: number; offset: number; nextOffset: number | null } {
  const full = String(text ?? '')
  const start = Math.max(0, Math.floor(offset) || 0)
  const size = Math.max(1, Math.floor(limit) || 0)
  const body = full.slice(start, start + size)
  const nextOffset = start + size < full.length ? start + size : null
  return { text: body, total: full.length, offset: start, nextOffset }
}


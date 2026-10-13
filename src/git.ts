import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { LINT_EXT, LINT_SKIP } from './parsers/lint.js'
import { relativeTo } from './workspace.js'
import { runCli } from './toolchain.js'
/**
 * Git-backed change detection behind the incremental lint scope: which tracked and
 * untracked code files changed, and whether a project is a git checkout at all.
 */
/**
 * Uncommitted code files `--incremental` is expected to inspect, project-relative. Only tracked
 * modifications count: a new untracked .ets file is ignored by codelinter even
 * though it matches code-linter.json5 (so the docs' "new files" does not cover untracked ones).
 * Null when git cannot answer (not a repo, no git), which is the signal to run the full check
 * instead of silently under-checking.
 *
 * Paths come back relative to the REPOSITORY root while the caller works relative to the project,
 * so they are rebased; `core.quotepath=false` keeps a non-ASCII file name readable.
 *
 * Note: codelinter's "Files checked" counts files that produced a finding, not files scanned, so
 * it can never be used to tell "nothing to check" from "checked and clean" — this list is.
 */
export async function changedCodeFiles(project: string): Promise<string[] | null> {
  return (await codeStatusFiles(project))?.changed ?? null
}

/**
 * The new-but-unadded code files of a working tree. `--incremental` never inspects them — codelinter
 * works from the tracked change set — so a refactor that *adds* files reads as a clean run
 *. Reporting them is what turns "pretending to be clean" into "saying what was not looked
 * at"; the lint behaviour itself is unchanged.
 */
export async function untrackedCodeFiles(project: string): Promise<string[] | null> {
  return (await codeStatusFiles(project))?.untracked ?? null
}

/**
 * Both halves of `git status --porcelain` that linting cares about. One call for both, so the tool
 * never pays two status runs.
 */
export async function codeStatusFiles(project: string): Promise<{ changed: string[]; untracked: string[] } | null> {
  // `-uall` lists the files inside an untracked directory. The default collapses a wholly new folder into a
  // single trailing-slash entry, which the extension filter below drops — so the list that exists to say what
  // was NOT looked at came back empty for exactly the case it is for.
  const status = await runCli(['git', '-c', 'core.quotepath=false', 'status', '--porcelain', '-uall', '--', '.'], { cwd: project, timeoutMs: 15000 })
  if (status.code !== 0) return null
  const top = await runCli(['git', 'rev-parse', '--show-toplevel'], { cwd: project, timeoutMs: 15000 })
  const root = top.code === 0 ? top.output.split(/\r?\n/)[0].trim().replace(/\\/g, '/').replace(/\/+$/, '') : ''
  const changed: string[] = []
  const untracked: string[] = []
  for (const line of status.output.split(/\r?\n/)) {
    // Not a fixed-offset slice: `runCli` trims the whole output, so the FIRST line arrives
    // without its leading space (slicing 3 chars then ate the first letter of the
    // path, turning `Demo/entry/A.ets` into `emo/entry/A.ets`).
    const parsed = /^\s*([A-Z?!]{1,2})\s+(.+)$/.exec(line)
    if (!parsed) continue
    const rest = parsed[2].trim()
    // A rename reads `R  old -> new`; the new path is the one that exists now.
    const raw = rest.includes(' -> ') ? rest.slice(rest.lastIndexOf(' -> ') + 4) : rest
    const path = raw.replace(/^"(.*)"$/, '$1')
    const full = root ? relativeTo(project, join(root, path)) : path
    if (!/\.(ets|ts|js)$/.test(full)) continue
    if (parsed[1].includes('?')) untracked.push(full)
    else changed.push(full)
  }
  return { changed, untracked }
}

/**
 * How a requested lint scope resolves. `changed` needs a usable change set: without one the
 * incremental run can inspect nothing and still print a clean summary, so it escalates to the full
 * check — slower, but it cannot silently miss the file the caller just edited.
 */
export function lintScope(requested: string, changed: string[] | null): { full: boolean; escalated: boolean; checkedFiles: string[] | null } {
  if (requested === 'all') return { full: true, escalated: false, checkedFiles: null }
  if (changed === null) return { full: true, escalated: true, checkedFiles: null }
  return { full: false, escalated: false, checkedFiles: changed }
}

/** How many files a `--incremental` run is expected to inspect; null when git cannot say. */
export async function countChangedCode(project: string): Promise<number | null> {
  const files = await changedCodeFiles(project)
  return files === null ? null : files.length
}

/**
 * Hash every code/config file under the project. A `--fix` run reports only the issues it could
 * fix (the same directory prints 2 issues plain and "0 issues" with --fix while nothing
 * is touched), so its own summary is useless as a result. Hashing around the run is what tells us
 * how much source actually changed.
 */
export async function hashTree(root: string): Promise<Map<string, string> | null> {
  const out = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (LINT_SKIP.test(full)) continue
      if (entry.isDirectory()) await walk(full)
      else if (LINT_EXT.test(entry.name)) out.set(full, createHash('sha1').update(await readFile(full)).digest('hex'))
    }
  }
  try {
    await walk(root)
    return out
  } catch {
    return null
  }
}


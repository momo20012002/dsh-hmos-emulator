import { dirname, join, resolve, sep } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
/**
 * Workspace and project layer: directory scanning, HarmonyOS project roots, the session
 * working directory, module lists and hap paths. Reads the filesystem, runs nothing.
 */
/** Directories skipped by browse/scan. */
export const IGNORED_DIRS = new Set([
  'node_modules', 'oh_modules', '.git', '.hvigor', '.idea', '.ohpm',
  '.preview', '.cxx', '.appanalyzer', 'build',
])
/** Marker file identifying a HarmonyOS project root. */
export const PROJECT_MARK = 'build-profile.json5'
/** Coerce arbitrary input to an existing absolute dir (walks up at most 6 levels). */
export function normalizeDir(input) {
  let dir = input && input.trim() ? resolve(input) : homedir()
  for (let i = 0; i < 6 && !existsSync(dir); i += 1) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return existsSync(dir) && dir !== resolve(dir, sep) ? dir : homedir()
}

export function scanProjects(root, maxDepth = 3) {
  // A project root is the project. Descending would list its modules instead, because a HarmonyOS
  // module directory carries its own build-profile.json5 (in practice: scanning a project root
  // returned only "<project>/entry"), and selecting that would aim a deploy at a module directory.
  if (existsSync(join(root, PROJECT_MARK))) return [root]
  const found = []
  let queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && found.length < 60 && visited < 1200) {
    const next = []
    for (const { dir, depth } of queue) {
      visited += 1
      let names = []
      try {
        names = readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of names) {
        if (!entry.isDirectory()) continue
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
        const child = join(dir, entry.name)
        if (existsSync(join(child, PROJECT_MARK))) {
          found.push(child)
          if (found.length >= 60) break
        } else if (depth + 1 <= maxDepth) {
          next.push({ dir: child, depth: depth + 1 })
        }
      }
      if (found.length >= 60) break
    }
    queue = next
  }
  return found
}

// ── Project info (multi-module deploy) ──────────────────────────────────

/**
 * Minimal JSON5→JSON: drop comments, quote bare keys, drop trailing commas — each of the last two
 * only outside a string literal. Whole-text regexes cannot do that: `,\s*([}\]])` also reaches
 * inside a value, so {"reason": "a, }"} would silently lose its comma, and the bare-key pattern
 * would rewrite text inside a string the same way.
 */
export function stripJson5(text: string): string {
  let out = ''
  let i = 0
  let quote = ''          // current string delimiter; '' when outside a string
  let keyPending = false  // a bare key may start at the next non-space character
  while (i < text.length) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === '\\') { out += text.slice(i, i + 2); i += 2; continue }
      if (ch === quote) quote = ''
      out += ch
      i += 1
      continue
    }
    if (ch === '"') { quote = ch; out += ch; i += 1; keyPending = false; continue }
    if (ch === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (ch === '{') { keyPending = true; out += ch; i += 1; continue }
    if (ch === ',') {
      // A comma that is followed only by a closing bracket is a trailing comma. Comments count as nothing
      // here as well: this lookahead runs before they are stripped, and `, /* e */ ]` is a shape real project
      // files use — reading it as a real comma makes the whole configuration unparsable.
      let j = i + 1
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j += 1
        if (text[j] === '/' && text[j + 1] === '/') { while (j < text.length && text[j] !== '\n') j += 1; continue }
        if (text[j] === '/' && text[j + 1] === '*') {
          const end = text.indexOf('*/', j + 2)
          j = end === -1 ? text.length : end + 2
          continue
        }
        break
      }
      if (text[j] === '}' || text[j] === ']') { i += 1; continue }
      keyPending = true
      out += ch
      i += 1
      continue
    }
    if (keyPending && /[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < text.length && /[\w$]/.test(text[j])) j += 1
      let k = j
      while (k < text.length && /\s/.test(text[k])) k += 1
      if (text[k] === ':') { out += `"${text.slice(i, j)}"`; i = j; keyPending = false; continue }
    }
    if (!/\s/.test(ch)) keyPending = false
    out += ch
    i += 1
  }
  return out
}

/** A `module@target` spec as the CLI writes it: the module name alone, for comparing against the project. */
export const moduleName = (spec: string): string => String(spec).split('@')[0]

/** Read entry module names from build-profile.json5 modules[].name; [] when unparsable. */
export function readModules(project: string): string[] {
  const file = join(project, PROJECT_MARK)
  if (!existsSync(file)) return []
  try {
    const cfg = JSON.parse(stripJson5(readFileSync(file, 'utf8')))
    const mods = Array.isArray(cfg?.modules) ? cfg.modules : []
    return mods.map((m) => (m && typeof m.name === 'string' ? m.name : '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The project root a model tool should act on. An absolute path is taken as given; a relative one
 * is resolved against the **session workspace** — the same base screenshots use — instead of the
 * host process's cwd, which is wherever `dsh web` happened to start. A relative `projectPath` used
 * to resolve against that cwd, so a path that looked right in the conversation pointed at a
 * directory that did not exist, and the failure only surfaced later as a confusing message about
 * `modules` .
 */
export function projectRootOf(input, exec): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return ''
  return resolve(sessionWorkspace(exec), raw)
}

// ── Emulator start helpers (image precheck / readiness polling) ─────────

/** Strip the project root from a report path, so a finding reads like the lint File column does. */
export function relativeTo(root: string, file: string): string {
  const norm = (s: string) => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root)
  const f = norm(file)
  return r && f.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? f.slice(r.length + 1) : f
}

/** Newest hap under the module's standard hvigor output directory (standard layout). */
export function hapPathOf(project: string, module: string): string | null {
  const dir = join(project, module, 'build', 'default', 'outputs', 'default')
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.hap'))
    let best = ''
    let bestMs = -1
    for (const f of files) {
      const ms = statSync(join(dir, f)).mtimeMs
      if (ms > bestMs) { bestMs = ms; best = f }
    }
    return best ? join(dir, best) : null
  } catch {
    return null
  }
}

/**
 * The session workspace: the calling agent's session cwd, read off the tool-call context
 * (`exec.agent.session.header.cwd` — the durable absolute cwd the host recorded for the session).
 * Agentless calls (tests, bare dispatch) fall back to `process.cwd()`. This is where screenshots
 * belong: a path outside it is a path the agent cannot read back.
 */
export function sessionWorkspace(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : process.cwd()
}


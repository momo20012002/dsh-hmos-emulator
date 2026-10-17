/**
 * Panel decisions that depend only on host answers: which module a project selected, which device a
 * deploy targets, which project a scan keeps. Pure and React-free so the rules are testable without
 * rendering; colours stay in the view, which maps the returned tone to a theme token.
 */

/** A deploy device: the preferred serial when it is online, else the first one offered. */
export function pickDevice(list: readonly string[], preferred?: string): string {
  if (!list || !list.length) return ''
  if (preferred && list.includes(preferred)) return preferred
  return list[0]
}

/** The entry module to remember for a project: the remembered one, else `entry`, else the first. */
export function pickModule(modules: readonly string[], remembered?: string): string {
  if (remembered && modules.includes(remembered)) return remembered
  if (modules.includes('entry')) return 'entry'
  return modules[0] || ''
}

/**
 * A scan replaces the selection only when it no longer finds it: every open of the panel scans the
 * remembered directory, and silently switching the project there would aim a deploy at another app.
 * `found` is never empty here, so a miss falls back to the first hit the dropdown can render.
 */
export function keepScannedProject(found: readonly string[], current: string, keepSelection: boolean): string {
  return keepSelection && current && found.includes(current) ? current : found[0] || ''
}

/** `Pixel (127.0.0.1:5555)`, or the bare serial when no known instance claims it. */
export function deviceLabel(instances: readonly any[], serial: string): string {
  const name = instances.find((it) => it && it.serial === serial)?.name
  return name ? `${name} (${serial})` : String(serial)
}

/** A running instance reads as success, anything else as stopped; the view picks the token. */
export function statusTone(status: unknown): { tone: 'ok' | 'danger'; label: string } {
  return status === 'running' ? { tone: 'ok', label: '运行中' } : { tone: 'danger', label: '已停止' }
}

/**
 * What the switch's confirmation says it is switching to.
 *
 * The destination is named once, and the workbench carries the build that answered — the reader can see
 * which better-sidebar is about to take the panel without a second line of detection prose. The built-in
 * column has no build of its own to name: it is the shell itself.
 * @param target - the host the user picked.
 * @param version - the build the workbench reported, or '' when it reported none.
 * @returns the sentence both confirmation surfaces use.
 */
export function mountSwitchTitle(target: string, version: string): string {
  const name = target === 'better' ? 'better-sidebar' : '内置右侧栏'
  return target === 'better' && version !== '' ? `切换到 ${name} ${version}` : `切换到 ${name}`
}

/**
 * The account state the devecocli row shows, or null when there is nothing to say.
 *
 * The row names what the sign-in is *for* — signing materials, which `signature generate` cannot write without
 * an account — and it names **both** states: a label that only appears when something is wrong reads as an
 * error, while "签名账号已登录" says the line is a state. What to do about the missing one rides the tooltip
 * (`AUTH_HINT_TITLE`). A null state means the question could not be asked at all (no CLI), which says nothing
 * about the account.
 * @param signedIn - the toolchain report's `signedIn`: true, false, or null when it could not be read.
 * @returns the label, or null when the row should stay as it is.
 */
export function authHint(signedIn: unknown): string | null {
  if (signedIn === true) return '已登录'
  if (signedIn === false) return '未登录'
  return null
}

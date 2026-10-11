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
 * Whether a value off the shell's shared module table can be rendered as a component.
 *
 * React components are not all functions: `forwardRef` and `memo` return objects carrying a `$$typeof`
 * tag, and the shell's own atoms are wrapped that way — its `Button` is a `forwardRef`, so a
 * `typeof value === 'function'` test rejects a component that renders perfectly well.
 * @param value - the export to test.
 * @returns whether React would accept it as an element type.
 */
export function isRenderableComponent(value: unknown): boolean {
  if (typeof value === 'function') return true
  return typeof value === 'object' && value !== null && '$$typeof' in value
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

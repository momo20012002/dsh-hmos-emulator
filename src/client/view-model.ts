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

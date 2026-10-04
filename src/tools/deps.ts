import type { LayoutLine } from '../parsers/layout.js'
/** Everything the per-tool factories share: the API surface, the mounting context, and the
 *  per-mount device state (last dump, the two `changedOnly` baselines, the last screenshot). */

export interface ToolDeps {
  api: any
  ctx: any
  /** Last dump per device, so `click {id}` resolves the node the caller just read. */
  lastLayout: Map<string, LayoutLine[]>
  /** Baselines behind `changedOnly` / `waitForChange`; they must outlive one `execute` call. */
  lastRender: Map<string, string[]>
  lastDump: Map<string, string[]>
  /** Last screenshot per device, with its clip rect: a cropped capture cannot be a whole-screen baseline. */
  lastShot: Map<string, { path: string; clip?: { x: number; y: number; w: number; h: number } }>
  /** `emu_ui`'s `observe` rides the log tool along, so it needs that tool itself. */
  hmosLog?: any
}

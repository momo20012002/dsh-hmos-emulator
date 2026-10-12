import { makeEmu } from './emu.js'
import { makeEmuUi } from './emu-ui.js'
import { makeHmosDeploy } from './deploy.js'
import { makeHmosDevice } from './device.js'
import { makeHmosDocs } from './docs.js'
import { makeHmosLint } from './lint.js'
import { makeHmosLog } from './log.js'
import { makeHmosSetup } from './setup.js'
import type { LayoutLine } from '../parsers/layout.js'
import type { ToolDeps } from './deps.js'
/** The model tools: one factory per file, assembled here into the array the plugin registers. */

export function createToolDefs(api, ctx = null) {
  const lastLayout = new Map<string, LayoutLine[]>()
  const lastRender = new Map<string, string[]>()
  const lastDump = new Map<string, string[]>()
  const lastShot = new Map<string, { path: string; clip?: { x: number; y: number; w: number; h: number } }>()
  const deps: ToolDeps = { api, ctx, lastLayout, lastRender, lastDump, lastShot }
  const hmosLog = makeHmosLog(deps)
  return [
    makeEmu(deps),
    makeEmuUi({ ...deps, hmosLog }),
    makeHmosDeploy(deps),
    makeHmosDevice(deps),
    hmosLog,
    makeHmosDocs(deps),
    makeHmosLint(deps),
    makeHmosSetup(deps),
  ]
}

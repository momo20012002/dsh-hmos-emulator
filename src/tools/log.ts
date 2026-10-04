import { firstRunningSerial, resolveDevecoCli, runCli } from '../toolchain.js'
import { parseLogLines } from '../parsers/devecocli.js'
import { sessionWorkspace } from '../workspace.js'
import { tailText } from '../text.js'
import { TOOL_OUT_SCHEMA, shotFields, toolRender } from '../shots.js'
import { DEVICE_SERIAL } from './schema.js'
import type { ToolDeps } from './deps.js'
/** Device logs. */

export function makeHmosLog(deps: ToolDeps) {
  const { api, ctx } = deps
  return {
      name: 'hmos_log',
      description: 'Read recent device logs via devecocli log, parsed into {time, level, tag, message}. Clearing the buffer is a device command (hdc: hilog -r).',
      parameters: {
        type: 'object',
        properties: {
          bundle: { type: 'string', description: 'bundle name filter' },
          level: { type: 'string', enum: ['D', 'I', 'W', 'E', 'F'], description: 'level filter' },
          keyword: { type: 'string', description: 'keyword filter' },
          crash: { type: 'boolean', description: 'crash logs only' },
          since: { type: 'string', description: 'only logs from this far back (30s, 5m)' },
          tail: { type: 'integer', description: 'latest N lines (50, max 500)' },
          raw: { type: 'boolean', description: 'also return the raw text tail' },
          read: { type: 'boolean', description: 'crash: attach the screenshot taken with the crash log, not just its path' },
          device: DEVICE_SERIAL,
        },
        required: [],
      },
      output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
      async execute(args, exec) {
        const cli = resolveDevecoCli()
        if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
        const device = (typeof args?.device === 'string' && args.device.trim() ? args.device.trim() : '') || await firstRunningSerial(cli)
        if (!device) return { ok: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' }
        const tail = Number.isFinite(args?.tail) ? Math.max(1, Math.min(500, args.tail)) : 50
        const argv = ['log', '--device', device, '--tail', String(tail)]
        if (args?.crash) argv.push('--crash')
        if (typeof args?.level === 'string' && args.level) argv.push('--level', String(args.level))
        if (typeof args?.bundle === 'string' && args.bundle.trim()) argv.push('--bundle-name', args.bundle.trim())
        if (typeof args?.keyword === 'string' && args.keyword.trim()) argv.push('--keyword', args.keyword.trim())
        if (typeof args?.since === 'string' && args.since.trim()) argv.push('--from', args.since.trim())
        const r = await runCli([process.execPath, cli, ...argv], { timeoutMs: 60000 })
        if (r.code !== 0) return { ok: false, device, error: tailText(r.output, 8) }
        const text = r.output.trim()
        const lines = parseLogLines(r.output).slice(-tail)
        const result: any = { ok: true, device, tail, count: lines.length, lines }
        // Parsed lines are the point of this tool, but a run that parses to nothing (a wrapped or
        // unexpected format) must not look like "no logs", so hand back the raw tail instead.
        if (lines.length === 0) result.rawTail = text.length > 2000 ? text.slice(-2000) : text
        else if (args?.raw) result.rawTail = text.length > 8000 ? text.slice(-8000) : text
        // A crash log names the failure; the screenshot shows what the app was doing when it happened.
        if (args?.crash && lines.length > 0) {
          Object.assign(result, await shotFields(api, device, sessionWorkspace(exec), 'crash', ctx, args?.read === true))
        }
        return result
      },
  }
}

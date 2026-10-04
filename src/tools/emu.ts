import { ensureImageReady, parseJsonArray, resolveDevecoCli, runCli, throwIfAborted, waitDeviceReady } from '../toolchain.js'
import { tailText } from '../text.js'
import { TOOL_OUT_SCHEMA, toolRender } from '../shots.js'
import type { ToolDeps } from './deps.js'
/** Emulator instances: list, start and stop through devecocli. */

export function makeEmu(_deps: ToolDeps) {
  return {
      name: 'emu',
      description: 'List/start/stop emulators via devecocli (start waits until online).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'start', 'stop'], description: 'list | start (waits online) | stop' },
          name: { type: 'string', description: 'instance name (start/stop)' },
        },
        required: ['action'],
      },
      output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
      async execute(args, exec) {
        throwIfAborted(exec?.signal)
        const cli = resolveDevecoCli()
        if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
        const action = String(args?.action || '')
        if (action === 'list') {
          const r = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 30000, signal: exec?.signal })
          const instances = parseJsonArray(r.output).map((it) => ({ name: it.name, status: it.status, serial: it.serial ?? null, osVersion: it.osVersion }))
          return { ok: r.code === 0, instances, error: r.code === 0 ? '' : tailText(r.output, 5) }
        }
        const name = typeof args?.name === 'string' && args.name.trim() ? args.name.trim() : ''
        if (!name) return { ok: false, error: 'name is required for start/stop' }
        if (action === 'start') {
          try { await ensureImageReady(cli, name, exec?.signal) } catch (error) { return { ok: false, stage: 'image', error: error instanceof Error ? error.message : String(error), code: error?.code } }
          const r = await runCli([process.execPath, cli, 'emulator', 'start', name], { timeoutMs: 240000, signal: exec?.signal })
          if (r.code !== 0) return { ok: false, stage: 'start', code: r.code, error: tailText(r.output, 8) }
          const { ready, serial, aborted } = await waitDeviceReady(cli, name, { signal: exec?.signal })
          return { ok: !aborted, aborted, ready, serial, error: aborted ? 'tool call aborted' : '' }
        }
        if (action === 'stop') {
          const r = await runCli([process.execPath, cli, 'emulator', 'stop', name], { timeoutMs: 60000, signal: exec?.signal })
          return { ok: r.code === 0, code: r.code, error: r.code === 0 ? '' : tailText(r.output, 5) }
        }
        return { ok: false, error: `unknown action ${action}` }
      },
  }
}

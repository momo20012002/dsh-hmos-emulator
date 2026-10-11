import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { firstRunningSerial, resolveDevecoCli, runCli, throwIfAborted } from '../toolchain.js'
import { localPathFor } from '../local-path.js'
import { sessionWorkspace } from '../workspace.js'
import { tailText } from '../text.js'
import { TOOL_OUT_SCHEMA, toolRender } from '../shots.js'
import type { ToolDeps } from './deps.js'
/**
 * The device side of a running emulator: what it is, files in and out, and a database on it.
 *
 * Three verbs of one subject, each one command: `device view` (details as JSON), `device file
 * send|recv` (one file), `device sqlite3` (SQL against a database on the device). All take a device
 * and none take a project, so this tool never touches the workspace except to resolve the local half
 * of a transfer — a relative path there means "under this session's workspace", the same rule
 * `projectPath` follows, because that is the directory the caller can see.
 *
 * `sqlite3` hands its arguments over word by word: the CLI passes them to hdc as separate argv and
 * hdc joins them into the device-side command line. A value containing a space therefore cannot be
 * expressed through this path at all — no layer along it interprets quotes.
 */

/** Trimmed string, or empty. */
const asText = (value: unknown): string => (typeof value === 'string' && value.trim() ? value.trim() : '')

/** One device verb plus a file transfer or a database query; the device defaults to the running one. */
export function makeHmosDevice(_deps: ToolDeps) {
  return {
      name: 'hmos_device',
      description: 'Inspect a running device and read from it: view (details), send/recv (one file to or from it), sqlite3 (SQL against a database on it). Device defaults to the first running emulator.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['view', 'send', 'recv', 'sqlite3'], description: 'view | send (host to device) | recv (device to host) | sqlite3' },
          device: { type: 'string', description: 'serial or name (default: first running emulator)' },
          local: { type: 'string', description: 'send: the file to upload — recv: where to save it (relative means under the session workspace)' },
          remote: { type: 'string', description: 'path on the device: send destination, recv source, or the sqlite3 database' },
          sql: { type: 'string', description: 'sqlite3: SQL or a dot-command, one word per argument as a shell would pass it (default: .tables)' },
        },
        required: ['action'],
      },
      output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
      async execute(args, exec) {
        throwIfAborted(exec?.signal)
        const cli = resolveDevecoCli()
        if (!cli) return { ok: false, code: null, timedOut: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
        const action = String(args?.action || '')
        // The action decides which verb this is, so an unknown one is answered before anything is
        // probed: a device lookup that ran first would report "no device" to a caller whose mistake
        // was the action, and it would cost a spawn on every such call.
        if (!['view', 'send', 'recv', 'sqlite3'].includes(action)) {
          return { ok: false, action, code: null, timedOut: false, error: `unknown action ${action}` }
        }
        const device = asText(args?.device) || await firstRunningSerial(cli)
        // That lookup cannot be cancelled (the helper takes no signal), so a call aborted inside it
        // has to say so rather than read as "there is no device".
        if (exec?.signal?.aborted) return { ok: false, action, code: null, timedOut: false, aborted: true, error: 'tool call aborted' }
        if (!device) return { ok: false, action, code: null, timedOut: false, error: 'no running emulator; start one with emu {action:"start", name:"<instance>"}' }
        if (action === 'view') {
          const r = await runCli([process.execPath, cli, 'device', 'view', '-t', device, '--format', 'json'], { timeoutMs: 30000, signal: exec?.signal })
          let info: unknown
          try { info = JSON.parse(r.output) } catch { info = undefined }
          // A view that answered in prose is still an answer: keep the text rather than reporting
          // success with an empty body, which the caller cannot tell from "no device fields".
          const raw = info === undefined && r.code === 0 ? { output: tailText(r.output, 12) } : {}
          return {
            ok: r.code === 0, action, device, code: r.code, timedOut: r.timedOut === true,
            ...(info === undefined ? {} : { info }), ...raw,
            error: r.code === 0 ? '' : tailText(r.output, 5),
          }
        }
        if (action === 'send' || action === 'recv') {
          const remote = asText(args?.remote)
          const asked = asText(args?.local)
          if (!remote || !asked) return { ok: false, action, code: null, timedOut: false, error: `${action} needs both local and remote paths` }
          const local = localPathFor(asked, sessionWorkspace(exec))
          // Uploading a path that is not there is worth saying before a device round trip; a download
          // into a directory that does not exist yet is not the caller's problem to solve.
          if (action === 'send' && !existsSync(local)) return { ok: false, action, local, code: null, timedOut: false, error: `local file not found: ${local}` }
          if (action === 'recv') { try { mkdirSync(dirname(local), { recursive: true }) } catch { /* the CLI reports what it cannot write */ } }
          const argv = action === 'send'
            ? [process.execPath, cli, 'device', 'file', 'send', '--device', device, local, remote]
            : [process.execPath, cli, 'device', 'file', 'recv', '--device', device, remote, local]
          const r = await runCli(argv, { timeoutMs: 5 * 60 * 1000, signal: exec?.signal })
          return { ok: r.code === 0, action, device, local, remote, code: r.code, timedOut: r.timedOut === true, error: r.code === 0 ? '' : tailText(r.output, 6) }
        }
        const database = asText(args?.remote)
        if (!database) return { ok: false, action, code: null, timedOut: false, error: 'sqlite3 needs remote: the database path on the device' }
        const sql = asText(args?.sql) || '.tables'
        const r = await runCli([process.execPath, cli, 'device', 'sqlite3', '--device', device, database, ...sql.split(/\s+/)], { timeoutMs: 60000, signal: exec?.signal })
        return { ok: r.code === 0, action, device, database, sql, code: r.code, timedOut: r.timedOut === true, output: tailText(r.output, 40), error: r.code === 0 ? '' : tailText(r.output, 6) }
      },
  }
}

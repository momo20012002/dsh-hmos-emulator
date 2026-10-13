import { existsSync } from 'node:fs'
import { authStatus, resolveDevecoCli, runCli, throwIfAborted } from '../toolchain.js'
import { projectRootOf } from '../workspace.js'
import { stripAnsi } from '../parsers/devecocli.js'
import { tailText } from '../text.js'
import { TOOL_OUT_SCHEMA, toolRender } from '../shots.js'
import { PROJECT_ROOT } from './schema.js'
import type { ToolDeps } from './deps.js'
/**
 * The jobs that come up about once per project rather than once per round: scaffolding an app,
 * generating its signing materials, and creating or deleting an emulator instance.
 *
 * They share one tool because they share that shape: a caller needs each of them rarely, and every one
 * of them writes something that outlives the session. Keeping them out of `emu` and `hmos_deploy` keeps
 * those two about running code; keeping them in *a* tool is what makes them reachable at all, because a
 * capability the model cannot see is one it cannot ask for.
 *
 * System images are deliberately absent: they are hundreds of megabytes, so downloading one is the
 * user's errand, and the description says so rather than leaving a caller to ask for a verb that is not
 * there.
 */

/** The one-off jobs this tool runs. */
const SETUP_ACTIONS = ['app', 'sign', 'create-instance', 'delete-instance']

/** Trimmed string, or empty. */
const asText = (value: unknown): string => (typeof value === 'string' && value.trim() ? value.trim() : '')

/** A boolean parameter as prompts and scripts send it: a real boolean, or its word. */
function asBool(value: unknown): boolean {
  return value === true || value === 'true'
}

export function makeHmosSetup(_deps: ToolDeps) {
  return {
      name: 'hmos_setup',
      description: 'Call this only when the user explicitly asks for one of these jobs — never on your own initiative, and never as a guess at what a project seems to need. app: create a project. sign: sign an existing project. create-instance / delete-instance: add or remove an emulator instance. System images are not handled here: they are hundreds of megabytes, so ask the user to fetch one.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: SETUP_ACTIONS,
            description: 'app | sign | create-instance | delete-instance',
          },
          appName: { type: 'string', description: 'app: application name for the new project' },
          projectPath: PROJECT_ROOT,
          bundleName: { type: 'string', description: 'app: bundle name (default: com.example.<app-name>)' },
          apiLevel: { type: 'integer', description: 'app: API level (default: the SDK\'s; minimum 17)' },
          name: { type: 'string', description: 'create-instance / delete-instance: the instance name' },
          deviceType: { type: 'string', description: 'create-instance: phone|foldable|widefold|triplefold|tablet|2in1|wearable|tv' },
          osVersion: { type: 'string', description: 'create-instance: an image label the user has already fetched, e.g. HarmonyOS 6.0.1(21)' },
          force: { type: 'boolean', description: 'sign / create-instance: overwrite what is already there' },
        },
        required: ['action'],
      },
      output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
      async execute(args, exec) {
        throwIfAborted(exec?.signal)
        const cli = resolveDevecoCli()
        if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
        const action = String(args?.action || '')
        if (!SETUP_ACTIONS.includes(action)) return { ok: false, error: `unknown action ${action}` }
        const started = Date.now()
        const deviceType = asText(args?.deviceType)
        const osVersion = asText(args?.osVersion)
        const name = asText(args?.name)
        const force = asBool(args?.force)

        if (action === 'app') {
          const appName = asText(args?.appName)
          if (!appName) return { ok: false, action, error: 'app needs appName (the application name to scaffold)' }
          // The scaffold writes into a directory of its own making, so the path is only passed when the
          // caller named one: a default would decide where a new project lands without being asked.
          const at = asText(args?.projectPath)
          const argv = [
            'create', '--app-name', appName,
            ...(at ? ['--project-path', at] : []),
            ...(asText(args?.bundleName) ? ['--bundle-name', asText(args?.bundleName)] : []),
            ...(Number.isFinite(args?.apiLevel) ? ['--api-level', String(args.apiLevel)] : []),
          ]
          const r = await runCli([process.execPath, cli, ...argv], { timeoutMs: 300000, signal: exec?.signal })
          const out = stripAnsi(r.output)
          return {
            ok: r.code === 0, action, appName, code: r.code, timedOut: r.timedOut === true,
            durationMs: Date.now() - started, tail: tailText(out, r.code === 0 ? 8 : 30),
            ...(r.code === 0 ? {} : { error: tailText(out, 8) }),
          }
        }

        if (action === 'sign') {
          const project = projectRootOf(args?.projectPath, exec)
          if (!project) return { ok: false, action, error: 'sign needs projectPath (the project to sign)' }
          if (!existsSync(project)) return { ok: false, action, error: `应用工程路径不存在:${project}` }
          // The CLI has no --project for this verb; it signs whatever project it is standing in.
          const r = await runCli([process.execPath, cli, 'signature', 'generate', ...(force ? ['--force'] : [])], { cwd: project, timeoutMs: 300000, signal: exec?.signal })
          const out = stripAnsi(r.output)
          if (r.code === 0) {
            return {
              ok: true, action, projectPath: project, code: r.code, timedOut: r.timedOut === true,
              durationMs: Date.now() - started, tail: tailText(out, 8),
            }
          }
          // Signing needs a signed-in account, and the CLI's own words do not say so: one extra read turns
          // "signature failed" into the sentence the caller is about to guess at.
          const who = await authStatus(cli, exec?.signal)
          return {
            ok: false, action, projectPath: project, code: r.code, timedOut: r.timedOut === true,
            durationMs: Date.now() - started, tail: tailText(out, 30), signedIn: who.known ? who.signedIn : null,
            // Only a reading that succeeded may blame the account; a failed read leaves the cause open.
            error: !who.known
              ? `未能确认登录状态(auth status 读取失败),签名未完成。CLI 输出:${tailText(out, 6)}`
              : who.signedIn
                ? tailText(out, 8)
                : `未登录华为开发者账号,签名无法完成。请在终端执行 devecocli auth login 后重试。CLI 输出:${tailText(out, 6)}`,
          }
        }

        if (action === 'create-instance') {
          if (!name) return { ok: false, action, error: 'create-instance needs name (the instance to create)' }
          const argv = [
            'emulator', 'create', name,
            ...(deviceType ? ['--device-type', deviceType] : []),
            ...(osVersion ? ['--os-version', osVersion] : []),
            ...(force ? ['--force'] : []),
          ]
          const r = await runCli([process.execPath, cli, ...argv], { timeoutMs: 600000, signal: exec?.signal })
          const out = stripAnsi(r.output)
          return {
            ok: r.code === 0, action, name, code: r.code, timedOut: r.timedOut === true,
            durationMs: Date.now() - started, tail: tailText(out, r.code === 0 ? 8 : 30),
            ...(r.code === 0 ? {} : { error: tailText(out, 8) }),
          }
        }

        if (action === 'delete-instance') {
          if (!name) return { ok: false, action, error: 'delete-instance needs name (the instance to delete)' }
          const r = await runCli([process.execPath, cli, 'emulator', 'delete', name], { timeoutMs: 120000, signal: exec?.signal })
          const out = stripAnsi(r.output)
          return {
            ok: r.code === 0, action, name, code: r.code, timedOut: r.timedOut === true,
            tail: tailText(out, 8),
            ...(r.code === 0 ? {} : { error: tailText(out, 6) }),
          }
        }

        // Every action above returns, so this only keeps the function total if another is ever added and
        // forgotten here — a fall-through would answer `undefined` instead.
        return { ok: false, action, error: `unknown action ${action}` }
      },
  }
}

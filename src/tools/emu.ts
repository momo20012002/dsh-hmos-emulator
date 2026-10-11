import { ensureImageReady, parseJsonArray, resolveDevecoCli, runCli, throwIfAborted, waitDeviceReady } from '../toolchain.js'
import { tailText } from '../text.js'
import { TOOL_OUT_SCHEMA, toolRender } from '../shots.js'
import type { ToolDeps } from './deps.js'
/**
 * Emulator instances: list, start and stop through devecocli — plus the device controls that belong to
 * the same subject (rotate, power, volume, battery, geolocation, shake).
 *
 * The controls are separate CLI verbs under the same group, all shaped `<verb> --target <name>` and
 * all finished in seconds: they inject a state and return, so nothing here streams and nothing needs
 * the project. The instance must already be running, and the CLI applies its own version gate (Studio
 * 6.1.0 / Emulator 7.0) — both of which it reports in words, so the call passes that through rather
 * than inventing its own message.
 */

/** The actions that drive a running instance rather than start or stop one. */
const CONTROL_ACTIONS = ['rotate', 'power', 'volume', 'battery', 'geolocation', 'shake']

/** Trimmed string, or empty. */
const asText = (value: unknown): string => (typeof value === 'string' && value.trim() ? value.trim() : '')

/** A finite number, accepting the numeric strings a model sometimes sends. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * Whether a value was supplied at all — as opposed to supplied and unreadable.
 *
 * The two are different answers: an absent value is a missing argument, while a present `'abc'` is a
 * mistake that must not be silently dropped (a half-injected position still reports success).
 */
function suppliedButNotNumber(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '' && asNumber(value) === undefined
}

export function makeEmu(_deps: ToolDeps) {
  return {
      name: 'emu',
      description: 'Emulator instances: list, start, stop — plus controls for a running one (rotate, power, volume, battery, geolocation, shake).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'start', 'stop', ...CONTROL_ACTIONS],
            description: 'list | start | stop | one of the control verbs',
          },
          name: { type: 'string', description: 'instance name, or serial; controls accept either' },
          direction: { type: 'string', enum: ['left', 'right', 'up', 'down'], description: 'rotate: left|right — volume: up|down' },
          level: { type: 'number', description: 'battery: charge level 0-100' },
          status: { type: 'string', enum: ['charging', 'discharging'], description: 'battery: charging state' },
          longitude: { type: 'number', description: 'geolocation: longitude' },
          latitude: { type: 'number', description: 'geolocation: latitude' },
          altitude: { type: 'number', description: 'geolocation: metres' },
          heading: { type: 'number', description: 'geolocation: degrees' },
        },
        required: ['action'],
      },
      output: { schema: TOOL_OUT_SCHEMA, render: toolRender },
      async execute(args, exec) {
        throwIfAborted(exec?.signal)
        const cli = resolveDevecoCli()
        if (!cli) return { ok: false, error: 'devecocli not found; install @deveco/deveco-cli or set DSH_HMOS_DEVECO_CLI' }
        const action = String(args?.action || '')
        // The action comes first: without it, an unknown one would be answered as a missing instance
        // name, which names the wrong mistake.
        if (!['list', 'start', 'stop', ...CONTROL_ACTIONS].includes(action)) {
          return { ok: false, error: `unknown action ${action}` }
        }
        if (action === 'list') {
          const r = await runCli([process.execPath, cli, 'emulator', 'list', '--format', 'json'], { timeoutMs: 30000, signal: exec?.signal })
          const instances = parseJsonArray(r.output).map((it) => ({ name: it.name, status: it.status, serial: it.serial ?? null, osVersion: it.osVersion }))
          return { ok: r.code === 0, instances, error: r.code === 0 ? '' : tailText(r.output, 5) }
        }
        const name = asText(args?.name)
        if (CONTROL_ACTIONS.includes(action)) {
          if (!name) return { ok: false, action, error: `name is required for ${action} (the instance name, or its serial)` }
          const argv = [process.execPath, cli, 'emulator', action, '--target', name]
          if (action === 'rotate' || action === 'volume') {
            const direction = asText(args?.direction)
            if (!direction) return { ok: false, action, error: `direction is required for ${action}: rotate takes left|right, volume takes up|down` }
            // The CLI narrows each verb to its own two choices, so a cross pairing (`volume left`) is
            // rejected by it after a spawn; saying so here costs one comparison and no round trip.
            const allowed = action === 'rotate' ? ['left', 'right'] : ['up', 'down']
            if (!allowed.includes(direction)) return { ok: false, action, error: `${action} takes ${allowed.join('|')}, not ${direction}` }
            argv.push(direction)
          }
          if (action === 'battery') {
            if (suppliedButNotNumber(args?.level)) return { ok: false, action, error: `level must be a number, got ${JSON.stringify(args?.level)}` }
            const level = asNumber(args?.level)
            const status = asText(args?.status)
            if (level === undefined && !status) return { ok: false, action, error: 'battery needs level (0-100), status (charging|discharging), or both' }
            if (level !== undefined) argv.push('--level', String(level))
            if (status) argv.push('--status', status)
          }
          if (action === 'geolocation') {
            // The CLI wants at least one of the four; say so here rather than letting it report a
            // missing option, which reads like a mistake in how we called it. A value that was given
            // but does not read as a number is its own answer: dropping it would inject half a
            // position and still report success.
            const named: [string, unknown][] = [['longitude', args?.longitude], ['latitude', args?.latitude], ['altitude', args?.altitude], ['heading', args?.heading]]
            for (const [key, value] of named) {
              if (suppliedButNotNumber(value)) return { ok: false, action, error: `${key} must be a number, got ${JSON.stringify(value)}` }
            }
            const parts: [string, number | undefined][] = [
              ['--longitude', asNumber(args?.longitude)],
              ['--latitude', asNumber(args?.latitude)],
              ['--altitude', asNumber(args?.altitude)],
              ['--direction', asNumber(args?.heading)],
            ]
            if (parts.every(([, value]) => value === undefined)) {
              return { ok: false, action, error: 'geolocation needs at least one of longitude, latitude, altitude, heading' }
            }
            for (const [flag, value] of parts) if (value !== undefined) argv.push(flag, String(value))
          }
          const r = await runCli(argv, { timeoutMs: 60000, signal: exec?.signal })
          return { ok: r.code === 0, action, target: name, code: r.code, error: r.code === 0 ? '' : tailText(r.output, 5) }
        }
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

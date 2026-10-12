/**
 * How the plugin agrees with its host: optional services are wired with `ctx.inject`, never with a
 * module-level `inject` — declaring one would abort the whole composition load when a host lacks it.
 * The injected callback runs in a fiber that lives exactly while its service does, so what it
 * registers is also what gets unregistered; and the route names the panel sends are pinned against
 * the host allowlist here too, because nothing else compares those two lists.
 */
import { describe, it, expect, vi } from 'vitest'
import { API_PREFIX, METHODS } from '../src/http.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { apply } from '../lib/index.js'
import { hostService } from '../src/services.js'
import { createHostContext, mountPlugin } from './harness.js'

const TOOL_NAMES = ['emu', 'emu_ui', 'hmos_deploy', 'hmos_device', 'hmos_log', 'hmos_docs', 'hmos_lint', 'hmos_setup']

describe('service access', () => {
  it('hands back the published service, and undefined for one the host does not publish', () => {
    const tools = { register: () => () => {} }
    const ctx = { get: (name: string) => (name === 'tools' ? tools : undefined) }
    expect(hostService(ctx as any, 'tools')).toBe(tools)
    // Absence is a normal state for every service this plugin uses, so it must not throw.
    expect(hostService(ctx as any, 'webRuntime')).toBeUndefined()
  })
})

describe('service wiring', () => {
  it('asks for each service by name and wires what its callback registers', () => {
    const host = mountPlugin()
    expect(host.requested).toEqual([['webServer'], ['tools'], ['systemPrompt']])
    expect(host.routes).toHaveLength(1)
    expect(host.tools.map((def) => def.name)).toEqual(TOOL_NAMES)
    expect(host.effects.map((effect) => effect.label))
      .toEqual(['dsh-hmos-emulator: http api', 'dsh-hmos-emulator: model tools', 'dsh-hmos-emulator: code-check context'])
  })

  it('registers nothing, and arms no timer, while a service is not published', () => {
    const host = createHostContext()
    // A host that never publishes anything: `inject` stays silent, and nothing here may wait for it.
    const withheld = { ...host.ctx, inject: () => {} }
    vi.useFakeTimers()
    try {
      apply(withheld, {})
      expect([host.routes.length, host.tools.length]).toEqual([0, 0])
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect([host.routes.length, host.tools.length]).toEqual([0, 0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips a service that cannot serve, with a warning instead of a wait', () => {
    // A service object without the method we need is not usable yet, and waiting is the runtime's
    // job now: register nothing, say so, and leave the rest of the plugin running.
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const host = mountPlugin({ tools: {} })
      expect(host.tools).toEqual([])
      expect(host.routes).toHaveLength(1)
      expect(warned).toHaveBeenCalledTimes(1)
    } finally {
      warned.mockRestore()
    }
  })

  it('unregisters everything its fiber registered once that fiber is disposed', () => {
    const host = mountPlugin()
    expect([host.routes.length, host.tools.length]).toEqual([1, TOOL_NAMES.length])
    host.dispose()
    expect([host.routes.length, host.tools.length]).toEqual([0, 0])
  })
})

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_DIR = join(HERE, '..', 'src', 'client')
const TOOLS_DIR = join(HERE, '..', 'src', 'tools')

/** All TypeScript sources of one directory, concatenated: the names are what matters, not the file. */
function sourceOf(dir: string): string {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts'))
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n')
}

/** Route names the panel uses: `rpc('x')`, plus the streaming `fetch(`${API}/x`)`. */
function panelRoutes(): Set<string> {
  const text = sourceOf(CLIENT_DIR)
  const names = new Set<string>()
  for (const match of text.matchAll(/rpc\(\s*'([^']+)'/g)) names.add(match[1])
  for (const match of text.matchAll(/\$\{API\}\/([A-Za-z.]+)/g)) names.add(match[1])
  return names
}

/** Route names a model tool reaches through the api object. */
function toolRoutes(): Set<string> {
  const text = sourceOf(TOOLS_DIR)
  const names = new Set<string>()
  for (const match of text.matchAll(/api\.([A-Za-z.]+)/g)) names.add(match[1])
  for (const match of text.matchAll(/api\['([^']+)'\]/g)) names.add(match[1])
  return names
}

describe('panel/host route contract', () => {
  it('carries one API prefix in both halves', () => {
    const prefix = /export const API = '([^']+)'/.exec(readFileSync(join(CLIENT_DIR, 'rpc.ts'), 'utf8'))?.[1]
    expect(prefix).toBe(API_PREFIX)
  })

  it('names only allowlisted routes from the panel', () => {
    expect([...panelRoutes()].filter((name) => !METHODS.has(name)).sort()).toEqual([])
  })

  it('leaves no allowlisted route unreachable', () => {
    const reachable = new Set([...panelRoutes(), ...toolRoutes()])
    expect([...METHODS].filter((name) => !reachable.has(name)).sort()).toEqual([])
  })
})

/**
 * The client half as the page loads it: the loader envelope the host serves, the sidebar
 * registration and its teardown, the log outlet it reports failures through, and the theme
 * tokens the panel styles itself with. Reads the built bundle, so `pnpm build` must run first.
 */
import { readFileSync } from 'node:fs'
import { clientLoggerOf } from '../src/client/log.js'
import { describe, it, expect, vi } from 'vitest'

/**
 * The module the loader hands the page. Loaded once: importing the bundle runs its envelope, and a
 * second import would return the cached module without re-running it.
 */
let loaded: { spec: any; module: any } | undefined

async function loadClient() {
  if (loaded === undefined) {
    let spec: any
    ;(globalThis as any).window = { __ModuleLoader__: { load: (registered: any) => { spec = registered } } }
    try {
      await import('../lib/client.js')
    } finally {
      delete (globalThis as any).window
    }
    const noop = () => undefined
    // The host supplies React through the loader's `require`; registration needs no real renderer.
    const react = {
      createElement: noop,
      useState: () => [undefined, noop],
      useEffect: noop,
      useRef: () => ({ current: null }),
      useCallback: (fn: any) => fn,
      useMemo: (fn: any) => fn(),
    }
    loaded = { spec, module: spec.factory((id: string) => (id === 'react' ? react : {})) }
  }
  return loaded
}

/**
 * A client context whose sidebar service records the tab it is handed. `inject` mimics Cordis: the
 * callback runs only while the named service is published, and `service: false` is a host that
 * never publishes it.
 */
function fakeClientCtx({ service = true }: { service?: boolean } = {}) {
  const tabs: any[] = []
  const effects: { label?: string; dispose?: unknown }[] = []
  const requested: string[][] = []
  const ctx: any = {
    get: (name: string) => (service && name === 'betterSidebar'
      ? { registerTab: (tab: any) => { tabs.push(tab); return () => { tabs.length = 0 } } }
      : undefined),
    effect: (fn: () => unknown, label?: string) => {
      const dispose = fn()
      effects.push({ label, dispose })
      return dispose
    },
    inject: (names: string[], callback: (scoped: any) => void) => {
      requested.push(names)
      if (service) callback({ get: ctx.get, effect: ctx.effect })
    },
  }
  return { tabs, effects, requested, ctx }
}

describe('client bundle artifact', () => {
  it('registers through window.__ModuleLoader__.load with the package id', async () => {
    const { spec } = await loadClient()
    expect(spec).toBeTruthy()
    expect(spec.id).toBe('dsh-hmos-emulator')
    expect(typeof spec.factory).toBe('function')
  })

  it('styles the panel with the theme aliases the app actually defines', () => {
    // `--dsw-alias-*` are the theme's semantic tokens (78 of them, dark values overriding the light
    // ones on body[data-ds-dark-theme]). The `--dsh-*` names this panel used before are defined
    // nowhere in the app, so every `var(--dsh-x, fallback)` silently kept its hardcoded fallback and
    // the panel never followed the theme.
    const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    expect(bundle).not.toContain('--dsh-')
    expect(bundle).toContain('--dsw-alias-')
  })
})

describe('panel registration', () => {
  it('registers one sidebar tab under a labelled effect, and the teardown removes it', async () => {
    const { module } = await loadClient()
    const { ctx, tabs, effects, requested } = fakeClientCtx()
    module.apply(ctx)
    // The injected dependency is the service name better-sidebar publishes: renaming it here would
    // register nothing at all.
    expect(requested).toEqual([['betterSidebar']])
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ id: 'hmos:emulator', order: 55, single: true })
    expect(tabs[0].title()).toBe('鸿蒙模拟器')
    // Registration lives inside the injected scope, so the fiber owns its disposer and apply needs
    // no teardown effect of its own.
    expect(effects.map((effect) => effect.label)).toEqual(['dsh-hmos-emulator: register tab'])
    for (const effect of effects) if (typeof effect.dispose === 'function') effect.dispose()
    expect(tabs).toEqual([])
  })

  it('registers nothing, and arms no timer, when the sidebar service is never published', async () => {
    const { module } = await loadClient()
    const { ctx, tabs } = fakeClientCtx({ service: false })
    vi.useFakeTimers()
    try {
      module.apply(ctx)
      expect(tabs).toEqual([])
      // The point of the injected scope: waiting is the runtime's job, not a retry loop of ours.
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect(tabs).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('client logger', () => {
  it('prefers the context logger and keeps every argument', () => {
    const seen: any[][] = []
    const log = clientLoggerOf({
      logger: { error: (...args: any[]) => seen.push(['error', ...args]), warn: (...args: any[]) => seen.push(['warn', ...args]) },
    })
    log.warn('[dsh-hmos-emulator] betterSidebar 服务没有 registerTab,已跳过页签注册。')
    log.error('[dsh-hmos-emulator] 客户端注册异常(已隔离,不影响 DSH):', new Error('boom'))
    expect(seen).toEqual([
      ['warn', '[dsh-hmos-emulator] betterSidebar 服务没有 registerTab,已跳过页签注册。'],
      ['error', '[dsh-hmos-emulator] 客户端注册异常(已隔离,不影响 DSH):', expect.any(Error)],
    ])
  })

  it('falls back to the console when the context carries no logger', () => {
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      clientLoggerOf(undefined).warn('w')
      clientLoggerOf({}).error('e')
      expect(warns).toHaveBeenCalledWith('w')
      expect(errors).toHaveBeenCalledWith('e')
    } finally {
      warns.mockRestore()
      errors.mockRestore()
    }
  })
})

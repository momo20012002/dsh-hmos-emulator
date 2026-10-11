/**
 * The client half as the page loads it: the loader envelope the host serves, the mount switch that
 * decides which sidebar carries the panel, the log outlet failures are reported through, and the
 * theme tokens the panel styles itself with. The artifact cases read the built bundle, so
 * `pnpm build` must run first; the switch cases drive the source module so both hosts (and their
 * refusals) can be exercised without a browser.
 */
import { readFileSync } from 'node:fs'
import { clientLoggerOf } from '../src/client/log.js'
import { applyMount, mountStatus, retainNativeTab, switchMount, writeMode } from '../src/client/mount.js'
import { beforeEach, describe, it, expect, vi } from 'vitest'

/**
 * The module the loader hands the page. Loaded once: importing the bundle runs its envelope, and a
 * second import would return the cached module without re-running it.
 */
let loaded: { spec: any; module: any; primitives: any } | undefined

/** The shared UI primitives the shell resolves for the banner. */
const PRIMITIVES = '@deepseek-ai/dsh-client-ui-primitives'

/** The host's React, as the loader's `require` supplies it. `createElement` keeps its arguments, so a
 *  test can read what a component asked the shell to render without a DOM renderer. */
function reactStub() {
  const noop = () => undefined
  return {
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children }),
    useState: (initial: any) => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: noop,
    useRef: () => ({ current: null }),
    useCallback: (fn: any) => fn,
    useMemo: (fn: any) => fn(),
  }
}

/** The shared UI primitives, as the shell supplies them; the components are markers for assertions. */
function primitivesStub() {
  return { Toast: function Toast() { return null }, IconWarningOutlineRegular: function IconWarning() { return null } }
}

async function loadClient() {
  if (loaded === undefined) {
    let spec: any
    ;(globalThis as any).window = { __ModuleLoader__: { load: (registered: any) => { spec = registered } } }
    try {
      await import('../lib/client.js')
    } finally {
      delete (globalThis as any).window
    }
    // The host supplies React through the loader's `require`.
    const react = reactStub()
    const primitives = primitivesStub()
    loaded = {
      spec,
      primitives,
      module: spec.factory((id: string) => (id === 'react' ? react : id === PRIMITIVES ? primitives : {})),
    }
  }
  return loaded
}

/**
 * A client context modelling both sidebar hosts. `inject` mimics Cordis closely enough for the two
 * properties this plugin depends on: the callback runs only while every named service is
 * published, and the returned fiber is disposable — which is what a host switch uses to drop the
 * previous registration. Services left unpublished can appear later through the returned
 * `enableNative` / `enableBetter`, which is how the pending path is exercised.
 */
function fakeClientCtx({ native = true, better = false, empty = false, deferInject = false }: { native?: boolean; better?: boolean; empty?: boolean; deferInject?: boolean } = {}) {
  const types: any[] = []
  const bodies: any[] = []
  const tabs: any[] = []
  const requested: string[][] = []
  const fibers: { disposed: boolean; dispose: () => void }[] = []
  /** Registration order, so a switch can be proven to retire the old host before arming the new one. */
  const events: string[] = []
  /** Every reveal a switch asked for: the panel has to be on screen in the host that just took it. */
  const opened: string[] = []
  /** What every effect body returned, so the "plain disposer" shape can be asserted. */
  const effectReturns: any[] = []
  const slots = {
    // Like the shipped seat: the factory's disposer is owned by the fiber this call returns.
    inject: (_name: string, factory: () => any) => {
      const disposer = factory()
      const fiber = { disposed: false, dispose: () => { fiber.disposed = true; if (typeof disposer === 'function') disposer() } }
      return fiber
    },
    register: (options: any, component: any) => {
      const row = { options, component }
      bodies.push(row)
      return () => { const at = bodies.indexOf(row); if (at >= 0) bodies.splice(at, 1) }
    },
  }
  const services: Record<string, any> = {}
  const pending: { names: string[]; callback: (scoped: any) => void }[] = []
  const injectReturns: unknown[] = []
  const ctx: any = {
    get: (name: string) => services[name],
    effect: (fn: () => unknown, _label?: string) => {
      const result = fn()
      effectReturns.push(result)
      return typeof result === 'function' ? result : () => undefined
    },
    inject: (names: string[], callback: (scoped: any) => void) => {
      requested.push(names)
      // What an effect body returns is what Cordis collects as its disposer: a plain function is the
      // only shape it accepts, so every return is recorded for the assertion below.
      //
      // `deferInject` models the real host: a ready service still delivers its callback later than the
      // call that asked for it, which is the ordering a reveal has to survive.
      if (!deferInject && names.every((name) => services[name] !== undefined)) injectReturns.push(callback({ get: ctx.get, effect: ctx.effect }))
      else pending.push({ names, callback })
      const fiber = { disposed: false, dispose: () => { fiber.disposed = true } }
      fibers.push(fiber)
      return fiber
    },
  }
  const flush = () => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index]
      if (entry.names.every((name) => services[name] !== undefined)) {
        pending.splice(index, 1)
        injectReturns.push(entry.callback({ get: ctx.get, effect: ctx.effect }))
      }
    }
  }
  const enableNative = () => {
    services.slots = slots
    services.sidebarRight = { openTab: (kind: string) => { opened.push(`native:${kind}`) } }
    services.sidebarRightTabs = {
      register: (definition: any) => {
        types.push(definition)
        events.push('type-on')
        return () => {
          const at = types.indexOf(definition)
          if (at >= 0) types.splice(at, 1)
          events.push('type-off')
        }
      },
    }
    flush()
  }
  const enableBetter = () => {
    services.betterSidebar = {
      openTab: (seed: any) => { opened.push(`better:${seed && seed.type}`) },
      // Its own close face, which is what a switch back has to use: the tab it opened carries the
      // type as its id, and closing it is the only way to retire a tab whose type is about to go.
      closeTab: (tabId: string, scope?: { sessionId?: string }) => { events.push(`better-close:${tabId}@${scope?.sessionId ?? ''}`) },
      registerTab: (tab: any) => {
        tabs.push(tab)
        events.push('better-on')
        return () => { const at = tabs.indexOf(tab); if (at >= 0) tabs.splice(at, 1) }
      },
    }
    flush()
  }
  if (!empty) {
    if (native) enableNative()
    if (better) enableBetter()
  }
  return { ctx, types, bodies, tabs, requested, fibers, effectReturns, injectReturns, events, opened, flush, enableNative, enableBetter, services }
}

/** The panel and glyph the entry half hands the mount module. */
const view = { view: (props: any) => props, icon: (size?: number) => ({ size }) }

/** A page-scoped storage stub: the settings persist here, and tests must not share it. */
const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  ;(globalThis as any).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
  }
  // The requested host now lives in one store per module evaluation, so a case that needs a request
  // other than the default writes it through the product's own path. `native` is a no-op when the
  // request is already native — the store only persists on an actual change.
  writeMode('native')
})

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

describe('mount switch', () => {
  it('defaults to the native right Sidebar and registers both halves there', () => {
    const { ctx, types, bodies, tabs, requested } = fakeClientCtx({ native: true, better: true })
    const status = applyMount(ctx, view)
    // The native path waits for the tab registry and the slot service by name; that is the only
    // dependency the registration has.
    expect(requested).toEqual([['sidebarRightTabs', 'slots']])
    expect(types).toHaveLength(1)
    expect(types[0]).toMatchObject({ id: 'dsh-hmos-emulator/panel', kind: 'hmosEmulator' })
    expect(types[0].title()).toBe('鸿蒙模拟器')
    expect(types[0].guide[0]).toMatchObject({ id: 'panel', order: 55 })
    // The type and its body appear together: a dangling type would offer a tab nothing can draw.
    expect(bodies).toHaveLength(1)
    expect(bodies[0].options).toEqual({ name: 'sidebar.right.pane.tab', key: 'dsh-hmos-emulator/panel' })
    expect(bodies[0].component({ sessionId: 's1' })).toEqual({ scope: { sessionId: 's1' }, ctx })
    expect(tabs).toEqual([])
    expect(status).toMatchObject({ requested: 'native', effective: 'native', reason: '' })
  })

  it('hands Cordis only plain effect disposers, never a fiber', () => {
    // Regression: returning `slots.inject(...)` from the effect body gave Cordis a thenable that
    // settles to an object, which it rejects as an invalid effect and then tears the registration
    // down with — the type and its body both vanished, leaving the opened tab on the owner's
    // "nothing can view this" notice.
    const { ctx, effectReturns } = fakeClientCtx({ native: true, better: true })
    applyMount(ctx, view)
    expect(effectReturns.length).toBeGreaterThan(0)
    for (const returned of effectReturns) {
      const plain = returned === undefined || returned === null || typeof returned === 'function'
      expect(plain).toBe(true)
    }
  })

  it('reveals the panel in the host that just took it, and never on a page load', () => {
    const { ctx, opened } = fakeClientCtx({ native: true, better: true })
    // Loading the page must not open tabs on its own: registration is enough.
    applyMount(ctx, view)
    expect(opened).toEqual([])
    switchMount(ctx, 'better')
    expect(opened).toEqual(['better:hmos:emulator'])
    switchMount(ctx, 'native')
    expect(opened).toEqual(['better:hmos:emulator', 'native:hmosEmulator'])
  })

  it('closes an open native tab before unregistering its type', () => {
    // Regression: unregistering the type alone left the already-open chip in the strip with no body
    // able to draw it, so the right Sidebar showed its "nothing can view this" notice instead.
    const { ctx, types, tabs, events } = fakeClientCtx({ native: true, better: true })
    applyMount(ctx, view)
    const release = retainNativeTab(() => events.push('tab-close'))
    const result = switchMount(ctx, 'better')
    expect(result.ok).toBe(true)
    expect(events).toEqual(['type-on', 'tab-close', 'type-off', 'better-on'])
    expect(types).toEqual([])
    expect(tabs).toHaveLength(1)
    release()
  })

  it('closes the better-sidebar tab by the id and session its body reported', () => {
    // Regression (reported twice from real switches): the reverse direction kept the orphan. Three
    // things are pinned here — the tab is closed at all; it is closed by the id the host opened it under
    // rather than by the plugin's type id (its own API documents that a tab id is not a type); and the
    // seat session travels with it, because that host restarts tab ids per session and an id alone would
    // resolve against whichever session is current.
    const { ctx, types, tabs, events } = fakeClientCtx({ native: true, better: true })
    writeMode('better')
    applyMount(ctx, view)
    expect(tabs).toHaveLength(1)
    // The host renders the body, which is where the open tab's id and session reach this plugin.
    tabs[0].component({ tab: { id: 'tab7' }, scope: { sessionId: 's2' } })
    const result = switchMount(ctx, 'native')
    expect(result.ok).toBe(true)
    // Asserted from the last close, because the mount module keeps its active record across cases and
    // this one starts by re-applying the requested host.
    const at = events.lastIndexOf('better-close:tab7@s2')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(events.slice(at)).toEqual(['better-close:tab7@s2', 'type-on'])
    expect(events).not.toContain('better-close:hmos:emulator')
    expect(tabs).toEqual([])
    expect(types).toHaveLength(1)
  })

  it('mounts where it can live when the requested host never arrives', () => {
    // Regression (independent review): a mount attempt that runs before either service publishes commits
    // to the requested host and arms its registration. If that host never appears while the other one
    // does, the panel was registered nowhere and shown nowhere — no tab, no entry, no line saying why —
    // and the stored request made it stick on every reload.
    const { ctx, types, tabs, enableNative } = fakeClientCtx({ native: false, better: false })
    writeMode('better')
    applyMount(ctx, view)
    expect(types).toEqual([])
    // The built-in column turns up; better-sidebar never does.
    enableNative()
    expect(types).toHaveLength(1)
    expect(tabs).toEqual([])
    expect(mountStatus()).toMatchObject({ effective: 'native' })
    expect(mountStatus().reason).toContain('dsh-better-sidebar')
  })

  it('keeps the request for this page when the shell publishes no client store', () => {
    // The store is a module-table row, and a shell without it must not take the whole plugin down: the
    // guard in host-store falls back to memory. Asserted here as the contract the fallback owes —
    // the request still decides the mount, and nothing pretends to be written to storage.
    writeMode('better')
    const { ctx, types, tabs } = fakeClientCtx({ native: true, better: true })
    applyMount(ctx, view)
    expect(mountStatus()).toMatchObject({ requested: 'better', effective: 'better' })
    expect(tabs).toHaveLength(1)
    expect(types).toEqual([])
    expect(store.has('dsh-hmos-emulator:mount')).toBe(false)
  })

  it('un-greys a host whose service publishes after the panel mounted', () => {
    // Regression (reported from a real host restart): the built-in half stayed greyed for the rest of
    // the page. The probe is a snapshot and a mount only publishes two of them, so the services that
    // were absent at mount have to be followed until they arrive.
    const { ctx, enableNative, requested } = fakeClientCtx({ native: false, better: true })
    applyMount(ctx, view)
    expect(mountStatus()).toMatchObject({ nativeReady: false, betterReady: true, effective: 'better' })
    // Only the absent side is armed: nothing is watched for the host that was already up.
    expect(requested).toEqual([['betterSidebar'], ['slots'], ['sidebarRightTabs']])
    enableNative()
    expect(mountStatus()).toMatchObject({
      nativeReady: true,
      betterReady: true,
      services: { slots: true, tabs: true, better: true },
      // The panel stays where it landed, and the line now offers the switch instead of the refusal.
      effective: 'better',
      reason: '内置右侧栏已就绪,现在可切换。',
    })
  })

  it('opens the chosen host only once its registration landed', () => {
    // Regression (reported from a real switch: the panel did not come up by itself). The reveal used to
    // be asked for right after the mount attempt, which is before the registration callback runs — the
    // right column throws for a kind it has never seen and better-sidebar returns silently, so the tab
    // was left for the user to open by hand.
    const { ctx, events, opened, flush } = fakeClientCtx({ native: true, better: true, deferInject: true })
    applyMount(ctx, view)
    flush()
    // A page load arms a host without opening anything in it.
    expect(opened).toEqual([])
    switchMount(ctx, 'better')
    // The host cannot be asked yet: nothing of ours is registered with it at this point.
    expect(opened).toEqual([])
    flush()
    // Registered first, then asked: the order the host's own API requires.
    expect(events[events.length - 1]).toBe('better-on')
    expect(opened).toEqual(['better:hmos:emulator'])
  })

  it('moves to better-sidebar on request, dropping the native registration first', () => {
    const { ctx, types, bodies, tabs, fibers } = fakeClientCtx({ native: true, better: true })
    applyMount(ctx, view)
    const result = switchMount(ctx, 'better')
    expect(result).toEqual({ ok: true, reason: '' })
    // One transport only: the native type and body are gone before the better tab exists.
    expect(types).toEqual([])
    expect(bodies).toEqual([])
    expect(fibers[0].disposed).toBe(true)
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ id: 'hmos:emulator', order: 55, single: true })
    expect(tabs[0].title()).toBe('鸿蒙模拟器')
    expect(tabs[0].component({ scope: { sessionId: 's2' } })).toEqual({ scope: { sessionId: 's2' }, ctx })
    expect(mountStatus()).toMatchObject({ requested: 'better', effective: 'better' })
  })

  it('moves back to native and keeps one registration at every step', () => {
    const { ctx, types, bodies, tabs } = fakeClientCtx()
    applyMount(ctx, view)
    switchMount(ctx, 'better')
    switchMount(ctx, 'native')
    expect(tabs).toEqual([])
    expect(types).toHaveLength(1)
    expect(bodies).toHaveLength(1)
    expect(types.length + tabs.length).toBe(1)
    expect(mountStatus()).toMatchObject({ requested: 'native', effective: 'native' })
  })

  it('refuses better-sidebar when no host publishes it, and keeps the preference native', () => {
    const { ctx, types, tabs } = fakeClientCtx({ native: true, better: false })
    applyMount(ctx, view)
    const result = switchMount(ctx, 'better')
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('dsh-better-sidebar')
    // The switch springs back: the request is untouched, so a later load on this page still asks for
    // native. (What a *reload* reads is the shell store's business, and tested where the shell is.)
    expect(mountStatus()).toMatchObject({ requested: 'native' })
    expect(mountStatus()).toMatchObject({ requested: 'native', effective: 'native', betterReady: false })
    expect(mountStatus().reason).toContain('dsh-better-sidebar')
    expect(types).toHaveLength(1)
    expect(tabs).toEqual([])
  })

  it('falls back to better-sidebar on a host without the native seat, and says why', () => {
    const { ctx, types, tabs } = fakeClientCtx({ native: false, better: true })
    const status = applyMount(ctx, view)
    expect(status).toMatchObject({ requested: 'native', effective: 'better' })
    expect(status.reason).toContain('内置右侧栏')
    expect(types).toEqual([])
    expect(tabs).toHaveLength(1)
    // Asking for the seat this host does not have is refused rather than half-registered.
    const refused = switchMount(ctx, 'native')
    expect(refused.ok).toBe(false)
    expect(refused.reason).toContain('内置右侧栏')
    expect(mountStatus().effective).toBe('better')
    expect(tabs).toHaveLength(1)
  })

  it('arms the requested host while its services are still unpublished, then settles', () => {
    // This is the instant between this bundle loading and the sidebar publishing its services; the
    // registration has to survive it instead of concluding that no host exists.
    const { ctx, types, bodies, enableNative } = fakeClientCtx({ empty: true })
    const status = applyMount(ctx, view)
    expect(status.effective).toBe('none')
    expect(status.reason).toContain('就绪')
    expect(types).toEqual([])
    enableNative()
    expect(types).toHaveLength(1)
    expect(bodies).toHaveLength(1)
    expect(mountStatus()).toMatchObject({ requested: 'native', effective: 'native', reason: '' })
  })

  it('registers nothing when neither host is available at all', () => {
    const { ctx, types, bodies, tabs, effectReturns } = fakeClientCtx({ empty: true })
    const status = applyMount(ctx, view)
    expect(status.effective).toBe('none')
    expect(types).toEqual([])
    expect(bodies).toEqual([])
    expect(tabs).toEqual([])
    // Nothing was produced because nothing was registered; the arming inject is the only effect.
    expect(effectReturns).toEqual([])
  })

  it('honours a persisted choice on the next load', () => {
    const first = fakeClientCtx({ native: true, better: true })
    applyMount(first.ctx, view)
    switchMount(first.ctx, 'better')
    const second = fakeClientCtx({ native: true, better: true })
    const status = applyMount(second.ctx, view)
    expect(status).toMatchObject({ requested: 'better', effective: 'better' })
    expect(second.tabs).toHaveLength(1)
    expect(second.types).toEqual([])
  })
})

describe('panel registration through the bundle', () => {
  it('loads on a host whose module table has no UI primitives', () => {
    // The banner comes from a module the shell shares, but the plugin must not need it to load: a
    // module-scope `require` would throw while the bundle is being evaluated — before apply's
    // try/catch — and take the whole client half (the panel included) down with it. Re-evaluated
    // here because the loader runs the envelope once, and the cached module cannot be re-registered.
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    let spec: any
    const host = { __ModuleLoader__: { load: (registered: any) => { spec = registered } } }
    new Function('window', source)(host)
    const module = spec.factory((id: string) => {
      if (id === 'react') return reactStub()
      throw new Error(`client-modules: no registered package factory for "${id}"`)
    })
    const { ctx, types, bodies, requested } = fakeClientCtx({ native: true, better: true })
    expect(() => module.apply(ctx)).not.toThrow()
    // Both effects still arm: the seat registers, and the component inside it simply renders nothing.
    expect(requested).toEqual([['slots'], ['sidebarRightTabs', 'slots']])
    expect(types).toHaveLength(1)
    expect(bodies).toHaveLength(2)
  })

  it('mounts the native host by default, and arms the shell\'s overlay for the check result', async () => {
    const { module } = await loadClient()
    const { ctx, types, bodies, tabs, requested } = fakeClientCtx({ native: true, better: true })
    module.apply(ctx)
    // Two independent effects: the notice entry needs only the slot service, the panel needs its host.
    expect(requested).toEqual([['slots'], ['sidebarRightTabs', 'slots']])
    expect(types).toHaveLength(1)
    expect(bodies).toHaveLength(2)
    // The check result rides the host's own transient banner, in the seat the shell declares for it.
    const overlay = bodies.find((row: any) => row.options.name === 'shell.overlay')
    expect(overlay.options).toMatchObject({ id: 'hmos-emulator.check-notice' })
    // The runtime turns `hooks.notice` into the entry's `useNotice`, so the registration carries the
    // observable, not a hook.
    const face = overlay.options.inject()
    expect(typeof face.hooks.notice.getSnapshot).toBe('function')
    expect(typeof face.hooks.notice.subscribe).toBe('function')
    expect(typeof face.dismiss).toBe('function')
    expect(typeof face.runAction).toBe('function')
    expect(tabs).toEqual([])
  })

  it('hands Cordis plain disposers for the overlay effect, never a fiber', async () => {
    const { module } = await loadClient()
    const { ctx, injectReturns } = fakeClientCtx({ native: true, better: true })
    module.apply(ctx)
    expect(injectReturns.length).toBeGreaterThan(0)
    for (const returned of injectReturns) {
      const plain = returned === undefined || returned === null || typeof returned === 'function'
      expect(plain).toBe(true)
    }
  })

  it('maps a check result onto the host banner, and renders nothing without the module', async () => {
    const { module, primitives } = await loadClient()
    const { ctx, bodies } = fakeClientCtx({ native: true, better: true })
    module.apply(ctx)
    const overlay = bodies.find((row: any) => row.options.name === 'shell.overlay')
    const runAction = vi.fn()
    const dismiss = vi.fn()
    const props = (state: any, anchor: any = null) => ({
      useNotice: (select: (current: any) => any) => select(state),
      useAnchor: (select: (current: any) => any) => select(anchor),
      dismiss,
      runAction,
    })
    const wait = { text: 'latest 通道最新版本 1.3.4(当前 1.3.0-stable)', action: { prefix: ' ', label: '立即更新' }, persist: true, seq: 4, channel: 'latest' }
    const banner = overlay.component(props(wait))
    // The host's own component, with the sentence, the separator, the action and the held lifetime.
    expect(banner.type).toBe(primitives.Toast)
    expect(banner.props).toMatchObject({ text: wait.text, anchor: null, holdMs: 24 * 60 * 60 * 1000, onDone: dismiss })
    expect(banner.props.actions).toEqual([{ prefix: ' ', label: '立即更新', onClick: runAction }])
    // A result with nothing to act on keeps the host's glyph and the host's fade.
    const settled = overlay.component(props({ text: 'latest 通道已是最新版本(1.3.4)', tone: 'success', seq: 5, channel: 'latest' }))
    expect(settled.props).toMatchObject({ tone: 'success' })
    expect(settled.props.actions).toBeUndefined()
    expect(settled.props.holdMs).toBeUndefined()
    // A check that could not complete takes the warning glyph and stays up.
    const warned = overlay.component(props({ text: '无法查询…', tone: 'warning', persist: true, seq: 6, channel: '' }))
    expect(warned.props.icon).toMatchObject({ type: primitives.IconWarningOutlineRegular })
    expect(warned.props.holdMs).toBe(24 * 60 * 60 * 1000)
    // Nothing to report renders nothing.
    expect(overlay.component(props(null))).toBeNull()
    // The anchor travels through: it is what centres the banner over the panel.
    const panel = {} as HTMLElement
    expect(overlay.component(props(wait, panel)).props.anchor).toBe(panel)
  })

  it('renders no banner at all on a host whose module table has no UI primitives', () => {
    // The other half of the lazy resolution: the entry is registered either way, and answers nothing
    // when the host cannot supply the banner it would draw with.
    const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
    let spec: any
    new Function('window', source)({ __ModuleLoader__: { load: (registered: any) => { spec = registered } } })
    const module = spec.factory((id: string) => {
      if (id === 'react') return reactStub()
      throw new Error(`client-modules: no registered package factory for "${id}"`)
    })
    const { ctx, bodies } = fakeClientCtx({ native: true, better: true })
    module.apply(ctx)
    const overlay = bodies.find((row: any) => row.options.name === 'shell.overlay')
    const rendered = overlay.component({
      useNotice: (select: (current: any) => any) => select({ text: 'x', seq: 1, channel: 'latest' }),
      useAnchor: (select: (current: any) => any) => select(null),
      dismiss: () => undefined,
      runAction: () => undefined,
    })
    expect(rendered).toBeNull()
  })

  it('mounts better-sidebar on a host that only publishes it', async () => {
    const { module } = await loadClient()
    const { ctx, tabs, types } = fakeClientCtx({ native: false, better: true })
    module.apply(ctx)
    expect(types).toEqual([])
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ id: 'hmos:emulator', order: 55, single: true })
  })

  it('registers nothing, and arms no timer, when neither host is published', async () => {
    const { module } = await loadClient()
    const { ctx, tabs, types } = fakeClientCtx({ empty: true })
    vi.useFakeTimers()
    try {
      module.apply(ctx)
      expect(types).toEqual([])
      expect(tabs).toEqual([])
      // The point of the injected scope: waiting is the runtime's job, not a retry loop of ours.
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect(types).toEqual([])
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
    log.warn('[dsh-hmos-emulator] 侧边栏承载不可用,面板未挂载。')
    log.error('[dsh-hmos-emulator] 客户端注册异常(已隔离,不影响 DSH):', new Error('boom'))
    expect(seen).toEqual([
      ['warn', '[dsh-hmos-emulator] 侧边栏承载不可用,面板未挂载。'],
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

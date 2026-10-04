/**
 * Shared host-side fakes: every service the plugin polls for, plus the registries the specs assert
 * on. A plain module rather than another `*.spec.ts`, so each spec declares only what it drives.
 */
import { apply } from '../lib/index.js'

/** Services a spec may hand in; anything omitted answers `undefined`, like an unmounted host. */
export interface HostFakes {
  tools?: any
  webServer?: any
  webRuntime?: any
  systemPrompt?: any
  attachments?: any
  agents?: any
}

export interface HostContext {
  /** The fake cordis context handed to `apply`. */
  ctx: any
  /** Tool definitions registered on the `tools` service, in order. */
  tools: any[]
  /** Routes registered on the `webServer` service, in order. */
  routes: any[]
  /** Effects installed, with their labels; `dispose()` runs every disposer. */
  effects: { label?: string; dispose?: unknown }[]
  /** Service names each `ctx.inject` call asked for, in order. */
  requested: string[][]
  /** Run every recorded disposer, the way the loader tears a fiber down. */
  dispose(): void
}

/**
 * Build the fake context without mounting, for a spec that drives `apply` itself (a second mount
 * against the same registry, for instance).
 */
export function createHostContext(fakes: HostFakes = {}): HostContext {
  const tools: any[] = []
  const routes: any[] = []
  const effects: { label?: string; dispose?: unknown }[] = []
  const requested: string[][] = []
  // A registry disposer removes its own entry, so a spec can observe the fiber-owned cleanup that
  // `ctx.inject` relies on.
  const services: Record<string, any> = {
    tools: {
      register: (def: any) => {
        tools.push(def)
        return () => { const at = tools.indexOf(def); if (at >= 0) tools.splice(at, 1) }
      },
    },
    webServer: {
      host: '127.0.0.1',
      register: (route: any) => {
        routes.push(route)
        return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1) }
      },
    },
    systemPrompt: { context: () => () => {} },
  }
  for (const [name, service] of Object.entries(fakes)) {
    if (service !== undefined) services[name] = service
  }
  const effect = (fn: () => unknown, label?: string) => {
    const dispose = fn()
    effects.push({ label, dispose })
    return dispose
  }
  const ctx: any = {
    get: (name: string) => services[name],
    effect,
    // Cordis runs the callback once the service is published, in a fiber of its own.
    inject: (names: string[], callback: (scoped: any) => void) => {
      requested.push(names)
      if (services[names[0]] !== undefined) callback({ get: ctx.get, effect, inject: ctx.inject })
    },
  }
  return {
    ctx,
    tools,
    routes,
    effects,
    requested,
    dispose() {
      for (const effect of effects) {
        if (typeof effect.dispose === 'function') (effect.dispose as () => void)()
      }
    },
  }
}

/** Mount the plugin against recording fakes, the way the host does. */
export function mountPlugin(fakes: HostFakes = {}): HostContext {
  const host = createHostContext(fakes)
  apply(host.ctx, {})
  return host
}

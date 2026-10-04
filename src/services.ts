/**
 * Host service wiring. Nothing here declares a module-level `inject`: the loader treats a missing
 * service as a composition error and aborts the whole load (that once left other host plugins
 * unmounted). Optional capabilities go through `ctx.inject`, whose callback runs in a fiber that
 * lives exactly while the service is published — a replaced service re-registers, a removed one
 * unregisters, and a host without it keeps loading without that capability.
 */
import { loggerOf } from './log.js'

/**
 * The host services this plugin consumes, in one place: the published name and the sliver of shape
 * we rely on. A typo or a rename then fails to compile instead of silently answering `undefined`,
 * which is what a string `ctx.get('…')` does. Only the members we actually call are declared.
 */
export interface HostServices {
  webServer: { host?: string; register(route: { kind: string; path: string; handler: any }): () => void }
  tools: { register(definition: any): () => void }
  systemPrompt: { context(entry: any): () => void }
  agents: { get?(id: string): any }
  webRuntime: { trustedHosts?: unknown; lanAddresses?: unknown }
  attachments: { saveImage?(input: any): Promise<any> }
}

export type HostServiceName = keyof HostServices

/** Read one of the services above; `undefined` when the host does not publish it. */
export function hostService<K extends HostServiceName>(
  ctx: { get(name: string): any },
  name: K,
): HostServices[K] | undefined {
  return ctx.get(name) ?? undefined
}

/**
 * Run one registration step behind the plugin's isolation promise: a failure only logs, so a broken
 * capability never takes the composition (or the rest of the plugin) down with it.
 */
export function isolate(label: string, ctx: any, step: () => void): void {
  try {
    step()
  } catch (error) {
    loggerOf(ctx).error(`[dsh-hmos-emulator] ${label}注册异常(已隔离,不影响 DSH):`, error)
  }
}

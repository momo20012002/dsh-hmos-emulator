/** The slice of the client context this plugin uses, kept apart so panel and entry share it. */
/* eslint-disable */
/** The Cordis core logger handle the browser context carries; present at runtime, optional here. */
export interface CtxLogger { error(...args: any[]): void; warn(...args: any[]): void }

export interface Ctx {
  get(name: string): any
  /** Returns the disposer Cordis owns for the effect, when the runtime hands one back. */
  effect(callback: () => any, label?: string): any
  /**
   * Run `callback` in a fiber that lives only while every named service is published. The returned
   * fiber is disposable, which is how a host switch tears the previous registration down.
   */
  inject(names: string[], callback: (scoped: Ctx) => void): any
  logger?: CtxLogger
}


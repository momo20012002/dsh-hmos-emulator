/**
 * The host half's log outlet. `ctx.logger` is a Cordis core handle rather than a service — nothing
 * to inject and nothing to declare — and it is what puts these lines in the host log, where a
 * missing CLI or a build that died silently has to be visible. A context without one (an older host,
 * a unit test) still gets them on the console, so no line is ever lost.
 */
export interface PluginLogger {
  error(...args: any[]): void
  warn(...args: any[]): void
}

/** The host logger when the context carries one, else the console; call sites keep their own prefix. */
export function loggerOf(ctx: any): PluginLogger {
  const logger = ctx?.logger
  if (logger !== null && typeof logger === 'object' && typeof logger.error === 'function') {
    return {
      error: (...args: any[]) => logger.error(...args),
      warn: (...args: any[]) => (typeof logger.warn === 'function' ? logger.warn(...args) : logger.error(...args)),
    }
  }
  return {
    error: (...args: any[]) => console.error(...args),
    warn: (...args: any[]) => console.warn(...args),
  }
}

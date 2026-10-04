/**
 * The client half's log outlet. The browser context carries the same Cordis core `logger` the host
 * does, so a registration failure lands in the client log instead of only in the developer console.
 * Falls back to the console when no logger is present, so nothing is swallowed.
 */
export interface ClientLogger {
  error(...args: any[]): void
  warn(...args: any[]): void
}

/** The client logger when the context carries one, else the console; call sites keep their prefix. */
export function clientLoggerOf(ctx: any): ClientLogger {
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

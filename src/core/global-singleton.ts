/**
 * Stores a singleton keyed on globalThis instead of a module-level variable.
 *
 * Next.js compiles instrumentation.ts, middleware.ts, and each Route Handler
 * into separate, disconnected module bundles (each its own entry point, not
 * one shared module graph) — a plain `let client` gives each bundle its own
 * independent copy instead of sharing the single instance init() created,
 * so captureException/startSpan/etc. called from a Route Handler would
 * never see the client instrumentation.ts's register() initialized.
 * globalThis is the one thing every bundle in the same running
 * process/isolate actually shares — this is the same reason Sentry's SDK
 * stashes its hub on globalThis internally rather than a module variable.
 */
export function globalSingleton<T>(key: string): { get(): T | undefined; set(value: T): void } {
  const g = globalThis as unknown as Record<string, T | undefined>
  return {
    get: () => g[key],
    set: (value: T) => {
      g[key] = value
    },
  }
}

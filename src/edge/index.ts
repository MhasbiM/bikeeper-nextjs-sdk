import { AsyncSpanStore } from '../core/async-span-store'
import { BikeeperClient } from '../core/client'
import type { ServerOptions } from '../core/options'
import { Span, type SpanOptions } from '../core/span'
import { DirectTransport } from '../core/transport'
import type { Contexts, Level } from '../core/types'

export type { CaptureExtra } from '../core/client'
export type { ServerOptions } from '../core/options'
export { Span } from '../core/span'
export type { SpanOptions } from '../core/span'

let client: BikeeperClient | undefined

const EDGE_CONTEXTS: Contexts = { runtime: { name: 'edge' } }

/** Initializes the Edge runtime SDK. Call this from `instrumentation.ts`'s
 * `register()`, gated on `process.env.NEXT_RUNTIME === 'edge'`, or directly
 * at the top of `middleware.ts` — both run on the same Edge runtime.
 * This module holds your real Bikeeper credentials; only import it from
 * server-side files (instrumentation.ts, middleware.ts), never from
 * "use client" code. */
export function init(options: ServerOptions): void {
  if (client) return
  client = new BikeeperClient({
    transport: new DirectTransport({
      endpoint: options.endpoint,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      projectId: options.projectId,
      timeoutMs: options.timeoutMs,
    }),
    spanStore: new AsyncSpanStore(),
    environment: options.environment,
    release: options.release,
    tracesSampleRate: options.tracesSampleRate,
    debug: options.debug,
    beforeSend: options.beforeSend,
    onError: options.onError,
    baseContexts: EDGE_CONTEXTS,
  })
}

function requireClient(): BikeeperClient | undefined {
  if (!client && typeof console !== 'undefined') {
    console.warn('[bikeeper] captured before init() was called — call init() first, event dropped')
  }
  return client
}

export function captureException(
  err: unknown,
  extra?: { tags?: Record<string, string>; level?: Level; url?: string },
  handled = true,
): void {
  requireClient()?.captureException(err, extra, handled)
}

export function captureMessage(message: string, level: Level = 'info', extra?: { tags?: Record<string, string>; url?: string }): void {
  requireClient()?.captureMessage(message, level, extra)
}

export function setTag(key: string, value: string): void {
  requireClient()?.setTag(key, value)
}

export function startSpan<T>(op: string, opts: SpanOptions, fn: (span: Span) => T | Promise<T>): Promise<T> {
  const c = requireClient()
  if (!c) {
    const noop = Span.createRoot(op, opts, false, undefined, { name: 'bikeeper-nextjs', version: '0.1.0' })
    return Promise.resolve(fn(noop)).finally(() => noop.finish())
  }
  return c.startSpan(op, opts, fn)
}

export function getActiveSpan(): Span | undefined {
  return client?.getActiveSpan()
}

export function flush(timeoutMs?: number): Promise<void> {
  return client?.flush(timeoutMs) ?? Promise.resolve()
}

/** Wraps `middleware.ts`'s default export: reports thrown errors (then
 * re-throws) and wraps the call in an `http.middleware` span. Kept generic
 * over the exact NextRequest/NextResponse types so this package doesn't
 * need a hard dependency on next/server's type exports. */
export function withMiddleware<A extends unknown[], R>(middleware: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const c = requireClient()
    if (!c) return middleware(...args)
    return c.startSpan('http.middleware', {}, async () => {
      try {
        return await middleware(...args)
      } catch (err) {
        c.captureException(err, undefined, false)
        throw err
      }
    })
  }
}

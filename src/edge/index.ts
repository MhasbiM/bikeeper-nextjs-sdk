import { SimpleHubStore } from '../core/simple-hub-store'
import { BikeeperClient, LogEntryBuilder, type LogLevelName } from '../core/client'
import { httpRequestInfo } from '../core/http-context'
import type { ServerOptions } from '../core/options'
import type { BreadcrumbInput, Scope } from '../core/scope'
import { Span, type SpanOptions } from '../core/span'
import { DirectTransport } from '../core/transport'
import type { Contexts, Level, UserInfo } from '../core/types'

export type { CaptureExtra } from '../core/client'
export type { ServerOptions } from '../core/options'
export type { BreadcrumbInput, Scope } from '../core/scope'
export { Span } from '../core/span'
export type { SpanOptions, TransactionSource } from '../core/span'
export type { NextRequestInfo, RequestErrorContext } from '../core/instrumentation-types'

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
    hubStore: new SimpleHubStore(),
    environment: options.environment,
    release: options.release,
    tracesSampleRate: options.tracesSampleRate,
    enableLogging: options.enableLogging,
    serverName: options.serverName,
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

export function captureEvent(event: Parameters<BikeeperClient['captureEvent']>[0]): Promise<void> {
  return requireClient()?.captureEvent(event) ?? Promise.resolve()
}

export function setTag(key: string, value: string): void {
  requireClient()?.setTag(key, value)
}

export function removeTag(key: string): void {
  requireClient()?.removeTag(key)
}

export function setUser(user: UserInfo | undefined): void {
  requireClient()?.setUser(user)
}

export function setExtra(key: string, ctx: Record<string, unknown>): void {
  requireClient()?.setExtra(key, ctx)
}

export function setFingerprint(...parts: string[]): void {
  requireClient()?.setFingerprint(...parts)
}

export function addBreadcrumb(input: BreadcrumbInput): void {
  requireClient()?.addBreadcrumb(input)
}

export function withScope<T>(fn: (scope: Scope) => T): T {
  const c = requireClient()
  if (!c) return fn(undefined as unknown as Scope)
  return c.withScope(fn)
}

/** Structured logging — gated by ServerOptions.enableLogging: on, sends to
 * /api/v1/logs; off (default), falls through to captureMessage. */
export const logger = {
  debug: (): LogEntryBuilder => requireLogEntry('debug'),
  info: (): LogEntryBuilder => requireLogEntry('info'),
  warn: (): LogEntryBuilder => requireLogEntry('warn'),
  error: (): LogEntryBuilder => requireLogEntry('error'),
  fatal: (): LogEntryBuilder => requireLogEntry('fatal'),
}

function requireLogEntry(level: LogLevelName): LogEntryBuilder {
  const c = requireClient()
  if (!c) return new LogEntryBuilder(level, () => {})
  return c[level]()
}

export function startSpan<T>(op: string, opts: SpanOptions, fn: (span: Span) => T | Promise<T>): Promise<T> {
  const c = requireClient()
  if (!c) {
    const noop = Span.createRoot(op, opts, false, undefined, { name: 'bikeeper-nextjs', version: '0.1.0' })
    return Promise.resolve(fn(noop)).finally(() => noop.finish())
  }
  return c.startSpan(op, opts, fn)
}

export function startTransaction<T>(name: string, opts: SpanOptions, fn: (span: Span) => T | Promise<T>): Promise<T> {
  const c = requireClient()
  if (!c) {
    const noop = Span.createRoot(name, opts, false, undefined, { name: 'bikeeper-nextjs', version: '0.1.0' })
    return Promise.resolve(fn(noop)).finally(() => noop.finish())
  }
  return c.startTransaction(name, opts, fn)
}

export function getActiveSpan(): Span | undefined {
  return client?.getActiveSpan()
}

export function flush(timeoutMs?: number): Promise<void> {
  return client?.flush(timeoutMs) ?? Promise.resolve()
}

/** Wraps `middleware.ts`'s default export: establishes a fresh isolated
 * scope for this request, auto-attaches HTTP request context when the first
 * argument looks like a Fetch API Request, reports thrown errors (then
 * re-throws), and wraps the call in an `http.middleware` span. Kept generic
 * over the exact NextRequest/NextResponse types so this package doesn't
 * need a hard dependency on next/server's type exports. */
export function withMiddleware<A extends unknown[], R>(middleware: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const c = requireClient()
    if (!c) return middleware(...args)
    const maybeReq = args[0]
    return c.withScope((scope) => {
      if (isFetchRequest(maybeReq)) scope.setHTTPContext(httpRequestInfo(maybeReq))
      return c.startSpan('http.middleware', { transactionSource: 'route' }, async () => {
        try {
          return await middleware(...args)
        } catch (err) {
          c.captureException(err, undefined, false)
          throw err
        }
      })
    })
  }
}

function isFetchRequest(value: unknown): value is Request {
  return typeof value === 'object' && value !== null && typeof (value as Request).headers?.forEach === 'function'
}

/** Edge-runtime counterpart of the server entry point's onRequestError —
 * needed because Next.js's instrumentation.ts is compiled separately per
 * runtime, but a plain `export { onRequestError } from
 * "bikeeper-nextjs-sdk/server"` at the top of instrumentation.ts is a
 * static re-export with no runtime guard, so it drags the ENTIRE /server
 * module (and its Node-only AsyncLocalStorage import) into the edge
 * compilation too. Select between this and the /server version inside your
 * own onRequestError wrapper, gated on process.env.NEXT_RUNTIME — see the
 * README's instrumentation.ts example. */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string; headers: Record<string, string> },
  context: { routerKind: string; routePath: string; routeType: string },
): Promise<void> {
  const c = requireClient()
  if (!c) return
  await c.withScope(async (scope) => {
    scope.setHTTPContext({ method: request.method, url: request.path, headers: request.headers })
    c.captureException(
      error,
      {
        tags: {
          route_path: context.routePath,
          route_type: context.routeType,
          router_kind: context.routerKind,
          method: request.method,
        },
        url: request.path,
      },
      false,
    )
    await c.flush(1000)
  })
}

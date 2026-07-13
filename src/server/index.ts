import 'server-only'

import { AsyncHubStore } from '../core/async-hub-store'
import { BikeeperClient, LogEntryBuilder, type LogLevelName } from '../core/client'
import { httpRequestInfo } from '../core/http-context'
import type { ServerOptions } from '../core/options'
import type { BreadcrumbInput, Scope } from '../core/scope'
import { Span, type SpanOptions } from '../core/span'
import { DirectTransport } from '../core/transport'
import type { Level, UserInfo } from '../core/types'
import { nodeContexts } from './node-context'

export type { CaptureExtra } from '../core/client'
export type { ServerOptions } from '../core/options'
export type { BreadcrumbInput, Scope } from '../core/scope'
export { Span } from '../core/span'
export type { SpanOptions, TransactionSource } from '../core/span'
export type { NextRequestInfo, RequestErrorContext } from './instrumentation'

let client: BikeeperClient | undefined

/** Initializes the server-side (Node.js runtime) SDK. Call this from
 * `instrumentation.ts`'s `register()`, gated on
 * `process.env.NEXT_RUNTIME === 'nodejs'` — this module holds your real
 * Bikeeper credentials and must never be imported from client code. */
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
    hubStore: new AsyncHubStore(),
    environment: options.environment,
    release: options.release,
    tracesSampleRate: options.tracesSampleRate,
    enableLogging: options.enableLogging,
    serverName: options.serverName,
    debug: options.debug,
    beforeSend: options.beforeSend,
    onError: options.onError,
    baseContexts: nodeContexts(),
  })
}

function requireClient(): BikeeperClient | undefined {
  if (!client && typeof console !== 'undefined') {
    console.warn('[bikeeper] captured before init() was called — call init() from instrumentation.ts first, event dropped')
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

/** Low-level escape hatch — send a fully-built EventPayload yourself
 * instead of using captureException/captureMessage. */
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

/** Runs `fn` against an isolated clone of the current scope — tags/user/
 * breadcrumbs set inside never leak out once it returns. Use this to scope
 * ad-hoc context to one operation without affecting the enclosing request. */
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

/** Always starts a new trace, ignoring any currently active span. */
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

/** Wraps an App Router Route Handler (`export async function GET(req) {...}`
 * in app/**\/route.ts): establishes a fresh, isolated scope for this
 * request (so setTag/setUser/addBreadcrumb calls made while handling it
 * never leak into a concurrent request), auto-attaches HTTP request context,
 * reports thrown errors (then re-throws, so Next.js's own error handling
 * still runs), and wraps the call in an `http.server` span. */
export function withRouteHandler<A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Promise<Response> | Response,
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req: Request, ...rest: A): Promise<Response> => {
    const c = requireClient()
    if (!c) return handler(req, ...rest)
    const pathname = safePathname(req.url)
    return c.withScope((scope) => {
      scope.setHTTPContext(httpRequestInfo(req))
      return c.startSpan(
        'http.server',
        { description: `${req.method} ${pathname}`, tags: { 'http.method': req.method, 'http.route': pathname }, transactionSource: 'route' },
        async (span) => {
          try {
            const res = await handler(req, ...rest)
            span.setHttpStatus(res.status)
            // Two distinct capture paths, matching bikeeperfiber/bikeeperecho:
            // a thrown error (below) and a handler that returns a 5xx
            // Response without throwing (e.g. Response.json(..., {status:
            // 500})) — the far more common pattern in Next.js Route
            // Handlers, so this must be captured too, not just panics.
            if (res.status >= 500) {
              c.captureMessage(`unhandled ${res.status} response`, 'error', {
                tags: { route: pathname, method: req.method, 'http.status_code': String(res.status) },
                url: pathname,
              })
            }
            return res
          } catch (err) {
            c.captureException(err, { tags: { route: pathname, method: req.method }, url: pathname }, false)
            throw err
          }
        },
      )
    })
  }
}

/** Wraps a Server Action: establishes a fresh isolated scope, reports
 * thrown errors (then re-throws), and wraps the call in a `server_action`
 * span. `name` is any label you choose (Server Actions have no built-in
 * route/name to read at runtime). */
export function withServerAction<A extends unknown[], R>(name: string, action: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const c = requireClient()
    if (!c) return action(...args)
    return c.withScope(() =>
      c.startSpan('server_action', { description: name, transactionSource: 'task' }, async () => {
        try {
          return await action(...args)
        } catch (err) {
          c.captureException(err, { tags: { server_action: name } }, false)
          throw err
        }
      }),
    )
  }
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** Ready to re-export as `onRequestError` from your `instrumentation.ts` —
 * matches Next.js's onRequestError hook shape exactly. Captures render/
 * route/action errors that Next.js's own instrumentation surfaces (this is
 * the only hook that also sees React Server Component render errors, which
 * withRouteHandler/withServerAction can't reach). Awaits a short flush since
 * serverless runtimes may freeze the function shortly after this returns. */
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

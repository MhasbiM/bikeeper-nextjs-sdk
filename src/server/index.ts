import 'server-only'

import { AsyncSpanStore } from '../core/async-span-store'
import { BikeeperClient } from '../core/client'
import type { ServerOptions } from '../core/options'
import { Span, type SpanOptions } from '../core/span'
import { DirectTransport } from '../core/transport'
import type { Level } from '../core/types'
import { nodeContexts } from './node-context'

export type { CaptureExtra } from '../core/client'
export type { ServerOptions } from '../core/options'
export { Span } from '../core/span'
export type { SpanOptions } from '../core/span'
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
    spanStore: new AsyncSpanStore(),
    environment: options.environment,
    release: options.release,
    tracesSampleRate: options.tracesSampleRate,
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

/** Wraps an App Router Route Handler (`export async function GET(req) {...}`
 * in app/**\/route.ts): reports thrown errors (then re-throws, so Next.js's
 * own error handling still runs) and wraps the call in an `http.server` span
 * named after the request method + pathname. */
export function withRouteHandler<A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Promise<Response> | Response,
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req: Request, ...rest: A): Promise<Response> => {
    const c = requireClient()
    if (!c) return handler(req, ...rest)
    const pathname = safePathname(req.url)
    return c.startSpan(
      'http.server',
      { description: `${req.method} ${pathname}`, tags: { 'http.method': req.method, 'http.route': pathname } },
      async (span) => {
        try {
          const res = await handler(req, ...rest)
          span.setHttpStatus(res.status)
          return res
        } catch (err) {
          c.captureException(err, { tags: { route: pathname, method: req.method }, url: pathname }, false)
          throw err
        }
      },
    )
  }
}

/** Wraps a Server Action: reports thrown errors (then re-throws) and wraps
 * the call in a `server_action` span. `name` is any label you choose (Server
 * Actions have no built-in route/name to read at runtime). */
export function withServerAction<A extends unknown[], R>(name: string, action: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const c = requireClient()
    if (!c) return action(...args)
    return c.startSpan('server_action', { description: name }, async () => {
      try {
        return await action(...args)
      } catch (err) {
        c.captureException(err, { tags: { server_action: name } }, false)
        throw err
      }
    })
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
}

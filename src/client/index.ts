'use client'

import { BikeeperClient, LogEntryBuilder, type LogLevelName } from '../core/client'
import { SDK_NAME, SDK_VERSION } from '../core/constants'
import { globalSingleton } from '../core/global-singleton'
import { DEFAULT_TUNNEL_URL, type ClientOptions } from '../core/options'
import { SimpleHubStore } from '../core/simple-hub-store'
import type { BreadcrumbInput, Scope } from '../core/scope'
import { Span, type SpanOptions } from '../core/span'
import { TunnelTransport } from '../core/transport'
import type { Level, UserInfo } from '../core/types'
import { browserContexts } from './browser-context'

export { BikeeperErrorBoundary } from './error-boundary'
export type { BikeeperErrorBoundaryProps } from './error-boundary'
export type { CaptureExtra } from '../core/client'
export type { ClientOptions } from '../core/options'
export type { BreadcrumbInput, Scope } from '../core/scope'
export { Span } from '../core/span'
export type { SpanOptions, TransactionSource } from '../core/span'

// globalThis-backed (not a plain module variable) because Next.js
// code-splits the client bundle per route too — a component in one chunk
// calling captureException could otherwise see a different module instance
// than the one init() ran in. See core/global-singleton.ts.
const clientStore = globalSingleton<BikeeperClient>('__bikeeper_client__')
const installedStore = globalSingleton<boolean>('__bikeeper_client_handlers_installed__')

/** Initializes the browser SDK. Call once, as early as possible — e.g. in a
 * top-level Client Component rendered from your root layout, or an
 * `instrumentation-client.ts` file if you're on a Next.js version that
 * supports it. Installs window-level handlers for uncaught errors and
 * unhandled promise rejections. */
export function init(options: ClientOptions = {}): void {
  if (clientStore.get()) return
  clientStore.set(
    new BikeeperClient({
      transport: new TunnelTransport({ tunnelUrl: options.tunnelUrl ?? DEFAULT_TUNNEL_URL }),
      hubStore: new SimpleHubStore(),
      environment: options.environment,
      release: options.release,
      tracesSampleRate: options.tracesSampleRate,
      enableLogging: options.enableLogging,
      debug: options.debug,
      beforeSend: options.beforeSend,
      onError: options.onError,
      baseContexts: browserContexts(),
    }),
  )
  installGlobalHandlers()
}

function installGlobalHandlers(): void {
  if (installedStore.get() || typeof window === 'undefined') return
  installedStore.set(true)

  window.addEventListener('error', (event: ErrorEvent) => {
    captureException(event.error ?? event.message, { level: 'error', url: window.location.href }, false)
  })

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    captureException(event.reason, { level: 'error', url: window.location.href }, false)
  })
}

function requireClient(): BikeeperClient | undefined {
  const client = clientStore.get()
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

/** Runs `fn` against an isolated clone of the current scope — see the
 * server entry point's withScope doc for the same semantics. Less critical
 * in the browser (one scope per tab already, not per-concurrent-request),
 * but still useful to scope a tag/breadcrumb to one operation. */
export function withScope<T>(fn: (scope: Scope) => T): T {
  const c = requireClient()
  if (!c) return fn(undefined as unknown as Scope)
  return c.withScope(fn)
}

/** Structured logging — gated by ClientOptions.enableLogging: on, sends to
 * /api/v1/logs (via the tunnel); off (default), falls through to
 * captureMessage. */
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
    // Not initialized — still run fn (it's real app logic), just against a
    // detached span that's guaranteed to never send anything.
    const noop = Span.createRoot(op, opts, false, undefined, { name: SDK_NAME, version: SDK_VERSION })
    return Promise.resolve(fn(noop)).finally(() => noop.finish())
  }
  return c.startSpan(op, opts, fn)
}

/** Always starts a new trace, ignoring any currently active span. */
export function startTransaction<T>(name: string, opts: SpanOptions, fn: (span: Span) => T | Promise<T>): Promise<T> {
  const c = requireClient()
  if (!c) {
    const noop = Span.createRoot(name, opts, false, undefined, { name: SDK_NAME, version: SDK_VERSION })
    return Promise.resolve(fn(noop)).finally(() => noop.finish())
  }
  return c.startTransaction(name, opts, fn)
}

/** Manual-lifecycle span for two-phase async flows that don't fit
 * startSpan's single-callback shape (e.g. an HTTP client's separate
 * request/response interceptors) — call span.finish() yourself when done. */
export function startSpanManual(op: string, opts?: SpanOptions): Span {
  const c = requireClient()
  if (!c) return Span.createRoot(op, opts, false, undefined, { name: SDK_NAME, version: SDK_VERSION })
  return c.startSpanManual(op, opts)
}

export function getActiveSpan(): Span | undefined {
  return clientStore.get()?.getActiveSpan()
}

/** Headers to attach to an outgoing HTTP call (e.g. an axios/fetch call to
 * a Bikeeper-instrumented backend) so it continues this same trace instead
 * of starting a disconnected one — the receiving server's withRouteHandler/
 * withMiddleware reads this same header on the way in. */
export function getTraceHeaders(): Record<string, string> {
  return clientStore.get()?.getTraceHeaders() ?? {}
}

export function flush(timeoutMs?: number): Promise<void> {
  return clientStore.get()?.flush(timeoutMs) ?? Promise.resolve()
}

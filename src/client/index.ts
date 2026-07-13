'use client'

import { BikeeperClient } from '../core/client'
import { DEFAULT_TUNNEL_URL, type ClientOptions } from '../core/options'
import { SimpleSpanStore } from '../core/simple-span-store'
import { Span, type SpanOptions } from '../core/span'
import { TunnelTransport } from '../core/transport'
import type { Level } from '../core/types'
import { browserContexts } from './browser-context'

export { BikeeperErrorBoundary } from './error-boundary'
export type { BikeeperErrorBoundaryProps } from './error-boundary'
export type { CaptureExtra } from '../core/client'
export type { ClientOptions } from '../core/options'
export { Span } from '../core/span'
export type { SpanOptions } from '../core/span'

let client: BikeeperClient | undefined
let installed = false

/** Initializes the browser SDK. Call once, as early as possible — e.g. in a
 * top-level Client Component rendered from your root layout, or an
 * `instrumentation-client.ts` file if you're on a Next.js version that
 * supports it. Installs window-level handlers for uncaught errors and
 * unhandled promise rejections. */
export function init(options: ClientOptions = {}): void {
  if (client) return
  client = new BikeeperClient({
    transport: new TunnelTransport({ tunnelUrl: options.tunnelUrl ?? DEFAULT_TUNNEL_URL }),
    spanStore: new SimpleSpanStore(),
    environment: options.environment,
    release: options.release,
    tracesSampleRate: options.tracesSampleRate,
    debug: options.debug,
    beforeSend: options.beforeSend,
    onError: options.onError,
    baseContexts: browserContexts(),
  })
  installGlobalHandlers()
}

function installGlobalHandlers(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (event: ErrorEvent) => {
    captureException(event.error ?? event.message, { level: 'error', url: window.location.href }, false)
  })

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    captureException(event.reason, { level: 'error', url: window.location.href }, false)
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
    // Not initialized — still run fn (it's real app logic), just against a
    // detached span that's guaranteed to never send anything.
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

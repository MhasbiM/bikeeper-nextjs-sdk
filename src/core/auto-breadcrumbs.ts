import type { BikeeperClient } from './client'
import { globalSingleton } from './global-singleton'

const CONSOLE_LEVELS = ['debug', 'log', 'info', 'warn', 'error'] as const
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number]

const CONSOLE_LEVEL_TO_BREADCRUMB_LEVEL: Record<ConsoleLevel, 'debug' | 'info' | 'warning' | 'error'> = {
  debug: 'debug',
  log: 'info',
  info: 'info',
  warn: 'warning',
  error: 'error',
}

const consoleInstalled = globalSingleton<boolean>('__bikeeper_console_breadcrumbs_installed__')

/** Wraps console.log/info/warn/error/debug so every call also leaves a
 * breadcrumb — the same trail Sentry's Console integration builds. The
 * original console output is untouched, just observed. globalThis-guarded
 * so calling init() more than once (or racing across two Next.js-split
 * bundles that both think they're first) never wraps console twice. */
export function installConsoleBreadcrumbs(client: BikeeperClient): void {
  if (consoleInstalled.get() || typeof console === 'undefined') return
  consoleInstalled.set(true)

  for (const level of CONSOLE_LEVELS) {
    const original = console[level]?.bind(console)
    if (!original) continue
    console[level] = (...args: unknown[]) => {
      client.addBreadcrumb({
        category: 'console',
        level: CONSOLE_LEVEL_TO_BREADCRUMB_LEVEL[level],
        message: formatConsoleArgs(args),
      })
      original(...args)
    }
  }
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
    .slice(0, 2000) // a pathologically large logged object shouldn't bloat the breadcrumb
}

const fetchInstalled = globalSingleton<boolean>('__bikeeper_fetch_breadcrumbs_installed__')

/** Wraps global fetch so every call also leaves an 'http'-category
 * breadcrumb (method, url, status_code, duration_ms). Safe to run alongside
 * this SDK's own transport — transport.ts captures its own fetch reference
 * before this ever installs, so the SDK's own event/log/transaction sends
 * never show up as breadcrumbs describing themselves. */
export function installFetchBreadcrumbs(client: BikeeperClient): void {
  const target = globalThis as typeof globalThis & { fetch?: typeof fetch }
  if (fetchInstalled.get() || typeof target.fetch !== 'function') return
  fetchInstalled.set(true)

  const original = target.fetch.bind(target)
  target.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input)
    const method = (init?.method ?? methodOf(input) ?? 'GET').toUpperCase()
    const start = Date.now()
    try {
      const response = await original(input, init)
      client.addBreadcrumb({
        category: 'fetch',
        type: 'http',
        level: response.ok ? 'info' : 'warning',
        message: `${method} ${url}`,
        data: { method, url, status_code: response.status, duration_ms: Date.now() - start },
      })
      return response
    } catch (err) {
      client.addBreadcrumb({
        category: 'fetch',
        type: 'http',
        level: 'error',
        message: `${method} ${url}`,
        data: { method, url, duration_ms: Date.now() - start, error: err instanceof Error ? err.message : String(err) },
      })
      throw err
    }
  }) as typeof fetch
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function methodOf(input: RequestInfo | URL): string | undefined {
  return typeof input === 'object' && !(input instanceof URL) ? input.method : undefined
}

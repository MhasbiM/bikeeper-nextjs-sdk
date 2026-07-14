import type { BikeeperClient } from '../core/client'
import { globalSingleton } from '../core/global-singleton'

interface TrackedXHR extends XMLHttpRequest {
  __bikeeperRequest?: { method: string; url: string }
}

const xhrInstalled = globalSingleton<boolean>('__bikeeper_xhr_breadcrumbs_installed__')

/** Wraps XMLHttpRequest so every call also leaves an 'xhr'-category
 * breadcrumb, same shape as installFetchBreadcrumbs — covers libraries
 * (older axios adapters, third-party widgets) that use XHR instead of
 * fetch. globalThis-guarded against double-wrapping. */
export function installXHRBreadcrumbs(client: BikeeperClient): void {
  if (xhrInstalled.get() || typeof XMLHttpRequest === 'undefined') return
  xhrInstalled.set(true)

  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (
    this: TrackedXHR,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    this.__bikeeperRequest = { method: method.toUpperCase(), url: url.toString() }
    return originalOpen.call(this, method, url, async ?? true, username, password)
  } as typeof originalOpen

  XMLHttpRequest.prototype.send = function (this: TrackedXHR, ...args: Parameters<typeof originalSend>) {
    const info = this.__bikeeperRequest
    if (info) {
      const start = Date.now()
      this.addEventListener('loadend', () => {
        client.addBreadcrumb({
          category: 'xhr',
          type: 'http',
          level: this.status === 0 || this.status >= 400 ? 'warning' : 'info',
          message: `${info.method} ${info.url}`,
          data: { method: info.method, url: info.url, status_code: this.status, duration_ms: Date.now() - start },
        })
      })
    }
    return originalSend.apply(this, args)
  }
}

const navigationInstalled = globalSingleton<boolean>('__bikeeper_navigation_breadcrumbs_installed__')

/** Wraps history.pushState/replaceState and listens for popstate so every
 * client-side route change leaves a 'navigation' breadcrumb — the same
 * signal Sentry's browser SDK builds from the History API. globalThis-
 * guarded against double-wrapping. */
export function installNavigationBreadcrumbs(client: BikeeperClient): void {
  if (navigationInstalled.get() || typeof window === 'undefined') return
  navigationInstalled.set(true)

  let currentUrl = window.location.href

  const recordNavigation = () => {
    const from = currentUrl
    const to = window.location.href
    if (from === to) return
    currentUrl = to
    client.addBreadcrumb({ category: 'navigation', message: `${from} -> ${to}`, data: { from, to } })
  }

  const originalPushState = history.pushState.bind(history)
  const originalReplaceState = history.replaceState.bind(history)

  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    const result = originalPushState(...args)
    recordNavigation()
    return result
  }
  history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
    const result = originalReplaceState(...args)
    recordNavigation()
    return result
  }
  window.addEventListener('popstate', recordNavigation)
}

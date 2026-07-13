import type { Contexts } from '../core/types'

/** Minimal, dependency-free UA sniffing — good enough for dashboard display,
 * not meant to be exhaustive (no need for a full ua-parser dependency just
 * for a browser/OS label on error events). */
export function browserContexts(): Contexts {
  if (typeof navigator === 'undefined') return {}
  const ua = navigator.userAgent

  const browserMatch = /(Firefox|Edg|Chrome|Safari)\/([\d.]+)/.exec(ua)
  const browser = browserMatch ? { name: normalizeBrowserName(browserMatch[1] as string), version: browserMatch[2] } : undefined

  let os: { name?: string; version?: string } | undefined
  if (/Windows NT/.test(ua)) os = { name: 'Windows', version: /Windows NT ([\d.]+)/.exec(ua)?.[1] }
  else if (/Mac OS X/.test(ua)) os = { name: 'macOS', version: /Mac OS X ([\d_.]+)/.exec(ua)?.[1]?.replace(/_/g, '.') }
  else if (/Android/.test(ua)) os = { name: 'Android', version: /Android ([\d.]+)/.exec(ua)?.[1] }
  else if (/iPhone|iPad|iPod/.test(ua)) os = { name: 'iOS', version: /OS ([\d_]+)/.exec(ua)?.[1]?.replace(/_/g, '.') }
  else if (/Linux/.test(ua)) os = { name: 'Linux' }

  return { browser, client_os: os }
}

function normalizeBrowserName(token: string): string {
  if (token === 'Edg') return 'Edge'
  return token
}

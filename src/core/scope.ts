import type { Breadcrumb, HTTPRequestInfo, Level, UserInfo } from './types'
import { nowISO } from './util'

const MAX_BREADCRUMBS = 50

export interface BreadcrumbInput {
  message: string
  category?: string
  type?: string
  level?: Level
  data?: Record<string, unknown>
}

/**
 * Holds everything that should be isolated per request/operation rather
 * than shared globally: tags, user, extra context, breadcrumbs,
 * fingerprint override, and HTTP request info. Mirrors bikeeper-go-sdk's
 * Scope. A fresh clone is created per incoming request (see hub-store.ts +
 * each entry point's withRouteHandler/withServerAction/withMiddleware) so
 * concurrent requests never see each other's tags/breadcrumbs — the bug the
 * old single-mutable-client-tags design had.
 */
export class Scope {
  private readonly tagMap: Record<string, string> = {}
  private userInfo: UserInfo | undefined
  private readonly extraMap: Record<string, Record<string, unknown>> = {}
  private crumbs: Breadcrumb[] = []
  private fingerprintOverride: string[] | undefined
  private httpContext: HTTPRequestInfo | undefined

  setTag(key: string, value: string): void {
    this.tagMap[key] = value
  }

  removeTag(key: string): void {
    delete this.tagMap[key]
  }

  tags(): Record<string, string> {
    return { ...this.tagMap }
  }

  setUser(user: UserInfo | undefined): void {
    this.userInfo = user
  }

  user(): UserInfo | undefined {
    return this.userInfo
  }

  /** Sets a named block of arbitrary structured data (bikeeper-go-sdk's
   * Hub.SetExtra/ExtraContext) — merged into Event.extra keyed by `key`. */
  setExtra(key: string, ctx: Record<string, unknown>): void {
    this.extraMap[key] = ctx
  }

  extra(): Record<string, Record<string, unknown>> {
    return { ...this.extraMap }
  }

  setFingerprint(...parts: string[]): void {
    this.fingerprintOverride = parts
  }

  fingerprint(): string[] | undefined {
    return this.fingerprintOverride
  }

  setHTTPContext(info: HTTPRequestInfo): void {
    this.httpContext = info
  }

  httpRequest(): HTTPRequestInfo | undefined {
    return this.httpContext
  }

  addBreadcrumb(input: BreadcrumbInput): void {
    const crumb: Breadcrumb = {
      timestamp: nowISO(),
      type: input.type,
      category: input.category,
      message: input.message,
      level: input.level ?? 'info',
      data: input.data,
    }
    this.crumbs.push(crumb)
    if (this.crumbs.length > MAX_BREADCRUMBS) {
      this.crumbs = this.crumbs.slice(this.crumbs.length - MAX_BREADCRUMBS)
    }
  }

  breadcrumbs(): Breadcrumb[] {
    return [...this.crumbs]
  }

  /** Deep-enough copy for per-request isolation and withScope() — after
   * cloning, mutations on either copy never affect the other. */
  clone(): Scope {
    const copy = new Scope()
    Object.assign(copy.tagMap, this.tagMap)
    copy.userInfo = this.userInfo
    Object.assign(copy.extraMap, this.extraMap)
    copy.crumbs = [...this.crumbs]
    copy.fingerprintOverride = this.fingerprintOverride ? [...this.fingerprintOverride] : undefined
    copy.httpContext = this.httpContext ? { ...this.httpContext } : undefined
    return copy
  }
}

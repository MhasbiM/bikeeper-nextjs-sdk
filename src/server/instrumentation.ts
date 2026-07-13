/** Mirrors Next.js's onRequestError hook shape (instrumentation.ts, App
 * Router) — kept as our own type so this package doesn't need a hard
 * dependency on Next.js's internal types. See:
 * https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation#onrequesterror-optional
 */
export interface RequestErrorContext {
  routerKind: 'Pages Router' | 'App Router'
  routePath: string
  routeType: 'render' | 'route' | 'action' | 'middleware'
  renderSource?: string
  revalidateReason?: 'on-demand' | 'stale' | undefined
}

export interface NextRequestInfo {
  path: string
  method: string
  headers: Record<string, string>
}

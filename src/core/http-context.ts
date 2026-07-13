import type { HTTPRequestInfo } from './types'

// Matches bikeeper-go-sdk's own stripped-headers list (event.go) — these
// must never reach a captured payload.
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-bikeeper-client-secret'])

/** Builds Bikeeper's HTTPRequestInfo from a Fetch API Request, stripping
 * sensitive headers — used to auto-attach request context to events
 * captured from withRouteHandler/withMiddleware, mirroring what
 * bikeeperfiber/bikeeperecho already do server-side in Go. */
export function httpRequestInfo(req: Request): HTTPRequestInfo {
  const url = new URL(req.url)
  const headers: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    if (!SENSITIVE_HEADERS.has(key.toLowerCase())) headers[key] = value
  })
  return {
    method: req.method,
    url: `${url.origin}${url.pathname}`,
    query_string: url.search ? url.search.slice(1) : undefined,
    headers,
  }
}

# bikeeper-nextjs-sdk

Error tracking + APM for Next.js (App Router), wire-compatible with
[bikeeper-go-sdk](https://github.com/MhasbiM/bikeeper-go-sdk) — events, logs,
and transaction/span traces sent by this SDK land in the same Bikeeper
project and dashboard as your Go services.

## Why client-side setup looks different from server-side

Bikeeper projects authenticate with a single shared secret
(`X-Bikeeper-Client-Secret`). That's fine for server-side code — it never
leaves your infrastructure — but it is **not safe to embed in browser JS**:
anyone could pull it out of your bundle and flood or forge events against
your project. So:

- **Server / Edge** (`/server`, `/edge`) talk to Bikeeper directly with your
  real credentials.
- **Browser** (`/client`) never sees your credentials at all. It posts to a
  same-origin Route Handler you mount using `/tunnel` — that route holds
  the real credentials server-side and forwards upstream. This is the same
  "tunnel" pattern Sentry's own Next.js SDK uses.

## Install

```bash
npm install bikeeper-nextjs-sdk
```

## 1. Server-side setup (`instrumentation.ts`)

```ts
// instrumentation.ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const Bikeeper = await import('bikeeper-nextjs-sdk/server')
    Bikeeper.init({
      clientId: process.env.BIKEEPER_CLIENT_ID!,
      clientSecret: process.env.BIKEEPER_CLIENT_SECRET!,
      projectId: process.env.BIKEEPER_PROJECT_ID!,
      endpoint: process.env.BIKEEPER_ENDPOINT, // e.g. https://bikeeper.example.com
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0.2, // 0 by default — opt in explicitly
    })
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    const Bikeeper = await import('bikeeper-nextjs-sdk/edge')
    Bikeeper.init({ /* same options */ } as any)
  }
}

// Also catches React Server Component render errors — the only place that
// can. IMPORTANT: don't write `export { onRequestError } from
// 'bikeeper-nextjs-sdk/server'` here — that's a static re-export with no
// runtime guard, so it drags the ENTIRE /server module (and its Node-only
// AsyncLocalStorage import) into the Edge compilation of this file too,
// which crashes every request through middleware.ts with "Runtime
// ReferenceError: __import_unsupported is not defined". Dynamically import
// the right runtime's implementation instead, exactly like register() does:
export async function onRequestError(
  ...args: Parameters<typeof import('bikeeper-nextjs-sdk/server').onRequestError>
) {
  const Bikeeper =
    process.env.NEXT_RUNTIME === 'edge'
      ? await import('bikeeper-nextjs-sdk/edge')
      : await import('bikeeper-nextjs-sdk/server')
  await Bikeeper.onRequestError(...args)
}
```

By default, `init()` in `/server` also registers `process.on('uncaughtException' | 'unhandledRejection', ...)` so errors thrown outside any request context (a background timer, a fire-and-forget promise, anything never wrapped by `withRouteHandler`/`withServerAction`) still get captured instead of crashing silently. An `uncaughtException` is captured, flushed, then the process exits — Node's own guidance is that the process is in an undefined state afterward and must not keep running; `unhandledRejection` is only captured, matching Node's non-fatal-by-default behavior. Set `captureUncaughtExceptions: false` in `init()` to opt out. (Edge has no full `process` event emitter, so this only applies to `/server`.)

## 2. Route Handlers & Server Actions

```ts
// app/api/orders/route.ts
import { withRouteHandler } from 'bikeeper-nextjs-sdk/server'

export const GET = withRouteHandler(async (req) => {
  return Response.json({ ok: true })
})
```

```ts
// app/actions.ts
'use server'
import { withServerAction } from 'bikeeper-nextjs-sdk/server'

export const createOrder = withServerAction('createOrder', async (input: OrderInput) => {
  // ...
})
```

## 3. Middleware (Edge runtime)

```ts
// middleware.ts
import { withMiddleware } from 'bikeeper-nextjs-sdk/edge'

export default withMiddleware((req) => {
  // ...
})
```

## 4. Tunnel route (required for any browser-side capture)

```ts
// app/monitoring/bikeeper/route.ts
import { createBikeeperTunnelRouteHandler } from 'bikeeper-nextjs-sdk/tunnel'

export const { POST } = createBikeeperTunnelRouteHandler({
  clientId: process.env.BIKEEPER_CLIENT_ID!,
  clientSecret: process.env.BIKEEPER_CLIENT_SECRET!,
  projectId: process.env.BIKEEPER_PROJECT_ID!,
  endpoint: process.env.BIKEEPER_ENDPOINT,
})
```

## 5. Browser setup

```tsx
// app/bikeeper-init.tsx
'use client'
import { useEffect } from 'react'
import { init } from 'bikeeper-nextjs-sdk/client'

export function BikeeperInit() {
  useEffect(() => {
    init({
      tunnelUrl: '/monitoring/bikeeper', // must match the route above
      environment: process.env.NODE_ENV,
      tracesSampleRate: 0.2,
    })
  }, [])
  return null
}
```

Render `<BikeeperInit />` once from your root layout. It installs
`window.onerror` / `unhandledrejection` handlers automatically.

For render errors in a specific subtree, wrap it in `BikeeperErrorBoundary`:

```tsx
import { BikeeperErrorBoundary } from 'bikeeper-nextjs-sdk/client'

<BikeeperErrorBoundary fallback={<p>Something broke.</p>}>
  <Widget />
</BikeeperErrorBoundary>
```

(Route-level errors are already caught by Next.js's own `error.tsx` +
`onRequestError` — use `BikeeperErrorBoundary` for finer-grained boundaries
inside a page.)

## Manual capture & tracing

Available from all three runtime entry points (`/client`, `/server`, `/edge`):

```ts
import { captureException, captureMessage, startSpan, setTag } from 'bikeeper-nextjs-sdk/server'

setTag('feature', 'checkout')

try {
  await chargePayment()
} catch (err) {
  captureException(err)
}

await startSpan('db.query', { description: 'GetOrder' }, async (span) => {
  span.setTag('order_id', orderId)
  return db.getOrder(orderId)
})
```

For two-phase async flows that don't fit `startSpan`'s single-callback shape — e.g. an HTTP client library's separate request/response interceptors — use `startSpanManual` and finish it yourself:

```ts
import { startSpanManual } from 'bikeeper-nextjs-sdk/client'

http.interceptors.request.use((config) => {
  config.bikeeperSpan = startSpanManual('http.client', { description: `${config.method} ${config.url}` })
  return config
})

http.interceptors.response.use(
  (response) => {
    response.config.bikeeperSpan?.setHttpStatus(response.status)
    response.config.bikeeperSpan?.finish()
    return response
  },
  (error) => {
    error.config?.bikeeperSpan?.setStatus('internal_error')
    error.config?.bikeeperSpan?.finish()
    return Promise.reject(error)
  },
)
```

## Distributed tracing

A single user action can span a browser call, your Next.js server, and
another Bikeeper-instrumented backend (e.g. a Go service using
bikeeper-go-sdk). By default each hop starts its own disconnected trace. To
link them into one trace, propagate a
[W3C `traceparent`](https://www.w3.org/TR/trace-context/) header on the
outgoing call and read it back on the receiving end.

Attach it to outgoing requests with `getTraceHeaders()` (available from all
three entry points — returns `{}` if there's no active span, so it's always
safe to spread):

```ts
// e.g. an axios request interceptor, browser or server side
import { getTraceHeaders } from 'bikeeper-nextjs-sdk/client'

http.interceptors.request.use((config) => {
  Object.assign(config.headers, getTraceHeaders())
  return config
})
```

Incoming `traceparent` headers are already read for you automatically —
`withRouteHandler` and `withMiddleware` both parse the request's `traceparent`
header and continue that trace instead of starting a new one, so a browser
call through `getTraceHeaders()` above into a route wrapped with
`withRouteHandler` is already one connected trace with no further wiring.
To continue an incoming trace in your own manual `startSpan`/`startTransaction`
call, parse the header yourself and pass `continueFrom`:

```ts
import { parseTraceparent } from 'bikeeper-nextjs-sdk/server' // re-exported from core
import { startTransaction } from 'bikeeper-nextjs-sdk/server'

const continueFrom = parseTraceparent(req.headers.get('traceparent'))
await startTransaction('worker.job', { continueFrom }, async (span) => {
  /* ... */
})
```

`continueFrom` is ignored if a locally-active parent span already exists
(that's already a correctly-nested continuation) — it only takes effect
when the call would otherwise start a brand-new root trace. A malformed or
missing header parses to `undefined`, so callers gracefully fall back to
starting a fresh trace rather than erroring.

## Reliability: retries & offline queueing

Every send (events, logs, transactions) retries up to 3 attempts with
backoff (0ms, 500ms, 1000ms) before giving up — a transient network blip or
a momentary 5xx from the Bikeeper backend doesn't drop the event.

The browser transport additionally queues in-memory when it can't reach the
tunnel: if `navigator.onLine` is already `false`, or a send fails after
retries, the item is queued (up to 50, dropping the oldest on overflow) and
flushed automatically once the `online` event fires. This is an **in-memory
queue only** — a hard page reload during an outage still loses whatever was
queued (no IndexedDB/localStorage persistence).

## Source maps & releases

Set a `release` identifier (e.g. your git SHA or a semver tag) on both
`init()` calls so events/spans can be matched to the exact deploy that
produced them:

```ts
Bikeeper.init({ /* ... */, release: process.env.NEXT_PUBLIC_APP_RELEASE })
```

Pipe the same value into your build (e.g. `--build-arg` in Docker, or a CI
env var baked in at build time) so it's stable across a deploy. Combined
with `productionBrowserSourceMaps: true` in `next.config.mjs`, this gives
you readable stack traces for browser errors without exposing the client
bundle's original source publicly on every request (Next only emits the
`.map` files alongside the build output; nothing about turning this on
serves them from a public, unauthenticated route by default beyond what
Next's own static file serving already does for `.next/static`).

> Bikeeper's backend doesn't yet resolve/store source maps server-side as
> of this writing — turning this on gets you correctly-mapped stack traces
> in browser devtools and any tooling that reads the `.map` files directly,
> but the dashboard itself still shows minified traces until that lands
> server-side.

## Scope: tags, user, breadcrumbs, extra context

Every incoming request handled through `withRouteHandler`/`withServerAction`/
`withMiddleware`/`onRequestError` gets its own **isolated scope** — `setTag`,
`setUser`, `addBreadcrumb`, etc. called while handling one request never
leak into a concurrent request, even though they all run in the same
process (this mirrors bikeeper-go-sdk's per-request Hub; a design with one
shared mutable tag map would race across concurrent requests).

```ts
import { setTag, setUser, addBreadcrumb, setExtra, withScope } from 'bikeeper-nextjs-sdk/server'

setUser({ id: user.id, email: user.email })
setTag('feature', 'checkout')
addBreadcrumb({ category: 'payment', message: 'charge attempted', level: 'info' })
setExtra('cart', { itemCount: cart.items.length })

// Scope a tag to just one operation, without it leaking past this call:
await withScope((scope) => {
  scope.setTag('sub_operation', 'refund')
  return processRefund(orderId)
})
```

`setHTTPContext` is called for you automatically by `withRouteHandler` and
`withMiddleware` (method/URL/query string/headers, with `Authorization`,
`Cookie`, `Set-Cookie`, and the Bikeeper secret header stripped) — call it
yourself only if you need to override it.

> **Backend note**: `user` and `extra` are sent on every event for wire
> parity with bikeeper-go-sdk, but the Bikeeper backend's ingest endpoint
> doesn't read those fields yet as of this writing — they won't appear in
> the dashboard until that lands server-side. `tags`, `breadcrumbs`, and
> `http_request` are already fully supported.

## Structured logging

Gated by `enableLogging` (default `false`, matching bikeeper-go-sdk): off,
`logger.*` calls fall through to `captureMessage`; on, they're sent as
`LogRecord`s to `/api/v1/logs` instead.

```ts
import { logger } from 'bikeeper-nextjs-sdk/server'

logger.info().withTag('order_id', orderId).emit('order created')
logger.error().emit('payment gateway timeout')
```

## Raw event capture

For full control over the payload instead of the scope-driven
`captureException`/`captureMessage` helpers:

```ts
import { captureEvent } from 'bikeeper-nextjs-sdk/server'

await captureEvent({
  id: crypto.randomUUID(),
  level: 'warning',
  message: 'custom event',
  timestamp: new Date().toISOString(),
})
```

## Sampling

`tracesSampleRate` (0–1) is head-based: rolled once per trace, inherited by
every child span. Defaults to `0` — upgrading this package alone never
starts sending performance data.

## Notes / current limitations

- App Router only (no Pages Router integration in this version).
- Route Handler spans use the request's actual pathname, not the route
  *pattern* (`/api/orders/123` rather than `/api/orders/[id]`) — dynamic
  segments won't automatically group in the Performance view.
- The browser **and** Edge (`/edge`, e.g. `middleware.ts`) scope/span store is
  a single module-scoped variable, not true per-async-chain isolation — fine
  for one traced operation at a time, but two concurrently-awaited traced
  operations can misattribute child spans or scope mutations. Edge doesn't
  use `AsyncLocalStorage` because `node:async_hooks` isn't reliably supported
  across edge bundlers (Turbopack's edge target throws
  `__import_unsupported is not defined` at runtime if it's imported — a hard
  crash, not a build warning). Only `/server` (Node.js runtime — Route
  Handlers, Server Actions, `instrumentation.ts`'s nodejs branch) uses
  `AsyncLocalStorage` and has true per-request isolation.
- `user`/`extra` fields are sent but currently dropped by the Bikeeper
  backend's ingest endpoint (see the Scope section above) — `tags`,
  `breadcrumbs`, and `http_request` are unaffected.

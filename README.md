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

// Also catches React Server Component render errors — the only place that can.
export { onRequestError } from 'bikeeper-nextjs-sdk/server'
```

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
- The browser scope/span store is a single module-scoped variable, not true
  per-async-chain isolation — fine for one traced operation at a time (a
  page load, one fetch), but two concurrently-awaited traced operations on
  the same page can misattribute child spans or scope mutations. Server/Edge
  use `AsyncLocalStorage` and don't have this limitation.
- `user`/`extra` fields are sent but currently dropped by the Bikeeper
  backend's ingest endpoint (see the Scope section above) — `tags`,
  `breadcrumbs`, and `http_request` are unaffected.

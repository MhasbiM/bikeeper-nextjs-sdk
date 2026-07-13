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

## Sampling

`tracesSampleRate` (0–1) is head-based: rolled once per trace, inherited by
every child span. Defaults to `0` — upgrading this package alone never
starts sending performance data.

## Notes / current limitations

- App Router only (no Pages Router integration in this version).
- Route Handler spans use the request's actual pathname, not the route
  *pattern* (`/api/orders/123` rather than `/api/orders/[id]`) — dynamic
  segments won't automatically group in the Performance view.
- The browser span store is a single module-scoped variable, not true
  per-async-chain isolation — fine for one traced operation at a time (a
  page load, one fetch), but two concurrently-awaited traced operations on
  the same page can misattribute child spans. Server/Edge use
  `AsyncLocalStorage` and don't have this limitation.

import type { EventPayload } from './types'

/** Options for the server/edge clients — these hold real Bikeeper
 * credentials and must never be constructed from code that ships to the
 * browser (only import "bikeeper-nextjs-sdk/server" or "/edge" from
 * server-only files: instrumentation.ts, Route Handlers, Server Actions,
 * middleware.ts). */
export interface ServerOptions {
  clientId: string
  clientSecret: string
  projectId: string
  /** Bikeeper backend base URL, e.g. https://bikeeper.example.com */
  endpoint?: string
  environment?: string
  release?: string
  /** Fraction of transactions (0-1) sent for APM. Defaults to 0 (disabled) —
   * matches bikeeper-go-sdk's opt-in-by-default philosophy: upgrading this
   * package alone should never silently start sending performance data. */
  tracesSampleRate?: number
  timeoutMs?: number
  debug?: boolean
  /** Mutate or drop (return null) an event right before it's sent. */
  beforeSend?: (event: EventPayload) => EventPayload | null
  onError?: (err: unknown) => void
}

/** Options for the browser client — deliberately has NO credential fields.
 * Events are POSTed to a same-origin tunnel route (see
 * "bikeeper-nextjs-sdk/tunnel") which holds the real credentials
 * server-side and forwards them upstream. */
export interface ClientOptions {
  /** Path to the tunnel Route Handler mounted in this app, e.g.
   * "/monitoring/bikeeper". Defaults to "/monitoring/bikeeper". */
  tunnelUrl?: string
  environment?: string
  release?: string
  tracesSampleRate?: number
  debug?: boolean
  beforeSend?: (event: EventPayload) => EventPayload | null
  onError?: (err: unknown) => void
}

export const DEFAULT_TUNNEL_URL = '/monitoring/bikeeper'

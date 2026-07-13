import {
  DEFAULT_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  HEADER_CLIENT_ID,
  HEADER_CLIENT_SECRET,
  HEADER_PROJECT_ID,
  HEADER_SDK_FRAMEWORK,
  INGEST_PATH,
  LOGS_PATH,
  SDK_FRAMEWORK,
  TRANSACTIONS_PATH,
} from './constants'
import type { EventPayload, LogRecordPayload, TransactionPayload } from './types'

export type WirePayload =
  | { kind: 'event'; payload: EventPayload }
  | { kind: 'log'; payload: LogRecordPayload }
  | { kind: 'transaction'; payload: TransactionPayload }

export interface Transport {
  send(item: WirePayload): Promise<void>
}

function pathFor(kind: WirePayload['kind']): string {
  switch (kind) {
    case 'event':
      return INGEST_PATH
    case 'log':
      return LOGS_PATH
    case 'transaction':
      return TRANSACTIONS_PATH
  }
}

async function postJSON(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
      // Fire-and-forget telemetry shouldn't hold a Node keep-alive-less
      // connection open past the request lifecycle in serverless runtimes.
      keepalive: true,
    })
    if (!res.ok) {
      throw new Error(`bikeeper transport: ${url} responded ${res.status}`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Sends directly to the Bikeeper backend using real project credentials.
 * Only safe to use server-side (Node runtime or Edge middleware) — never
 * construct this with code that ships to the browser. */
export class DirectTransport implements Transport {
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly headers: Record<string, string>

  constructor(opts: { endpoint?: string; clientId: string; clientSecret: string; projectId: string; timeoutMs?: number }) {
    this.endpoint = (opts.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.headers = {
      [HEADER_CLIENT_ID]: opts.clientId,
      [HEADER_CLIENT_SECRET]: opts.clientSecret,
      [HEADER_PROJECT_ID]: opts.projectId,
    }
  }

  async send(item: WirePayload): Promise<void> {
    const headers = item.kind === 'event' ? { ...this.headers, [HEADER_SDK_FRAMEWORK]: SDK_FRAMEWORK } : this.headers
    await postJSON(`${this.endpoint}${pathFor(item.kind)}`, item.payload, headers, this.timeoutMs)
  }
}

/** Posts to a same-origin tunnel Route Handler with no credentials attached
 * — the tunnel route (see "bikeeper-nextjs-sdk/tunnel") injects the real
 * headers server-side before forwarding upstream. Used by the browser
 * client, where embedding a Bikeeper secret would be unsafe. */
export class TunnelTransport implements Transport {
  private readonly tunnelUrl: string
  private readonly timeoutMs: number

  constructor(opts: { tunnelUrl: string; timeoutMs?: number }) {
    this.tunnelUrl = opts.tunnelUrl
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async send(item: WirePayload): Promise<void> {
    await postJSON(this.tunnelUrl, item, {}, this.timeoutMs)
  }
}

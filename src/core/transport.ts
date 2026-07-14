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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const MAX_ATTEMPTS = 3 // 1 initial + 2 retries
const RETRY_BACKOFF_MS = 500 // 500ms, then 1000ms

async function postOnce(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<void> {
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

/** POSTs with a small retry/backoff for transient failures (network blip,
 * momentary 5xx from the collector) — covers both DirectTransport and
 * TunnelTransport. Not a substitute for TunnelTransport's own offline queue
 * below, which handles a genuinely absent connection, not just a flaky one. */
async function postJSON(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(RETRY_BACKOFF_MS * attempt)
    try {
      await postOnce(url, body, headers, timeoutMs)
      return
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
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

const MAX_QUEUE_SIZE = 50

/** Posts to a same-origin tunnel Route Handler with no credentials attached
 * — the tunnel route (see "bikeeper-nextjs-sdk/tunnel") injects the real
 * headers server-side before forwarding upstream. Used by the browser
 * client, where embedding a Bikeeper secret would be unsafe.
 *
 * Also queues in-memory on failure (network blip beyond postJSON's own
 * retries, or the browser genuinely offline) and flushes when the `online`
 * event fires — covers the common "phone loses signal mid-session" case.
 * A hard page reload during an outage still loses whatever was queued;
 * this is an in-memory queue, not one persisted to storage. */
export class TunnelTransport implements Transport {
  private readonly tunnelUrl: string
  private readonly timeoutMs: number
  private readonly queue: WirePayload[] = []
  private flushing = false

  constructor(opts: { tunnelUrl: string; timeoutMs?: number }) {
    this.tunnelUrl = opts.tunnelUrl
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        void this.flushQueue()
      })
    }
  }

  async send(item: WirePayload): Promise<void> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.enqueue(item)
      return
    }
    try {
      await postJSON(this.tunnelUrl, item, {}, this.timeoutMs)
    } catch (err) {
      this.enqueue(item)
      throw err
    }
  }

  private enqueue(item: WirePayload): void {
    this.queue.push(item)
    if (this.queue.length > MAX_QUEUE_SIZE) this.queue.shift() // drop oldest, not newest
  }

  private async flushQueue(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0] as WirePayload
        try {
          await postJSON(this.tunnelUrl, item, {}, this.timeoutMs)
          this.queue.shift()
        } catch {
          break // still failing — stop draining, wait for the next `online` event
        }
      }
    } finally {
      this.flushing = false
    }
  }
}

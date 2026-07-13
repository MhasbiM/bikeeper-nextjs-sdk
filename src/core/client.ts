import { SDK_NAME, SDK_VERSION } from './constants'
import { toExceptionValue, messageOf } from './exception'
import { defaultFingerprint } from './fingerprint'
import { Span, type SpanContextStore, type SpanOptions } from './span'
import type { Transport } from './transport'
import type { Contexts, EventPayload, Level, Tag } from './types'
import { newEventId, nowISO } from './util'

export interface CaptureExtra {
  tags?: Record<string, string>
  level?: Level
  url?: string
}

export interface BikeeperClientOptions {
  transport: Transport
  spanStore: SpanContextStore
  environment?: string
  release?: string
  /** Fraction (0-1) of transactions sent for APM. */
  tracesSampleRate?: number
  debug?: boolean
  beforeSend?: (event: EventPayload) => EventPayload | null
  onError?: (err: unknown) => void
  /** Runtime-specific context merged into every event (os/runtime/browser). */
  baseContexts?: Contexts
}

const SDK_INFO = { name: SDK_NAME, version: SDK_VERSION }

export class BikeeperClient {
  private readonly globalTags: Record<string, string> = {}
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly opts: BikeeperClientOptions) {
    if (opts.environment) this.globalTags.environment = opts.environment
    if (opts.release) this.globalTags.release = opts.release
  }

  setTag(key: string, value: string): void {
    this.globalTags[key] = value
  }

  private buildTags(extra?: Record<string, string>): Tag[] | undefined {
    const merged = { ...this.globalTags, ...extra }
    const keys = Object.keys(merged)
    if (keys.length === 0) return undefined
    return keys.map((key) => ({ key, value: merged[key] as string }))
  }

  private activeTraceId(): string | undefined {
    return this.opts.spanStore.getActive()?.traceId
  }

  /** Captures a caught exception. `handled: true` because the app code
   * chose to call this — as opposed to an uncaught error a global handler
   * routes here with handled: false. */
  captureException(err: unknown, extra?: CaptureExtra, handled = true): void {
    const exception = toExceptionValue(err, handled)
    this.send({
      id: newEventId(),
      level: extra?.level ?? 'error',
      message: messageOf(err),
      tags: this.buildTags(extra?.tags),
      timestamp: nowISO(),
      url: extra?.url,
      trace_id: this.activeTraceId(),
      contexts: this.opts.baseContexts,
      sdk: SDK_INFO,
      exception,
      fingerprint: defaultFingerprint(messageOf(err), exception),
    })
  }

  captureMessage(message: string, level: Level = 'info', extra?: CaptureExtra): void {
    this.send({
      id: newEventId(),
      level,
      message,
      tags: this.buildTags(extra?.tags),
      timestamp: nowISO(),
      url: extra?.url,
      trace_id: this.activeTraceId(),
      contexts: this.opts.baseContexts,
      sdk: SDK_INFO,
      fingerprint: defaultFingerprint(message),
    })
  }

  /** Fire-and-forget send of a fully-built event — tracked so flush() can
   * wait for it, never throws (a broken transport must not surface as an
   * application error). */
  private send(event: EventPayload): void {
    const finalEvent = this.opts.beforeSend ? this.opts.beforeSend(event) : event
    if (!finalEvent) return
    const p = this.opts.transport.send({ kind: 'event', payload: finalEvent }).catch((err) => {
      this.opts.onError?.(err)
      if (this.opts.debug) console.error('[bikeeper] failed to send event', err)
    })
    this.track(p)
  }

  private track(p: Promise<void>): void {
    this.pending.add(p)
    void p.finally(() => this.pending.delete(p))
  }

  /** Starts a new trace (or a child span of whatever's active) and finishes
   * it automatically around `fn`, marking it failed if `fn` throws.
   * Sampling is head-based: rolled once when a NEW trace starts; a child of
   * an already-sampled (or already-unsampled) trace inherits that decision. */
  async startSpan<T>(op: string, opts: SpanOptions, fn: (span: Span) => T | Promise<T>): Promise<T> {
    const parent = this.opts.spanStore.getActive()
    const span = parent
      ? Span.createChild(op, opts, parent)
      : Span.createRoot(op, opts, Math.random() < (this.opts.tracesSampleRate ?? 0), this.opts.transport, SDK_INFO)
    try {
      return await this.opts.spanStore.runWithActive(span, () => fn(span))
    } catch (err) {
      span.setStatus('internal_error')
      throw err
    } finally {
      span.finish()
    }
  }

  getActiveSpan(): Span | undefined {
    return this.opts.spanStore.getActive()
  }

  async flush(timeoutMs = 2000): Promise<void> {
    if (this.pending.size === 0) return
    await Promise.race([
      Promise.allSettled(Array.from(this.pending)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }
}

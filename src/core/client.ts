import { SDK_NAME, SDK_VERSION } from './constants'
import { toExceptionValue, messageOf } from './exception'
import { defaultFingerprint } from './fingerprint'
import type { BreadcrumbInput } from './scope'
import { Scope } from './scope'
import { cloneState, type HubState, type HubStore } from './hub-store'
import { Span, type SpanOptions } from './span'
import type { Transport } from './transport'
import type { Contexts, EventPayload, HTTPRequestInfo, Level, LogRecordPayload, Tag, UserInfo } from './types'
import { newEventId, nowISO } from './util'

export interface CaptureExtra {
  tags?: Record<string, string>
  level?: Level
  url?: string
}

export interface BikeeperClientOptions {
  transport: Transport
  hubStore: HubStore
  environment?: string
  release?: string
  /** Fraction (0-1) of transactions sent for APM. */
  tracesSampleRate?: number
  /** Gates the Logger (debug/info/warn/error/fatal): true sends to
   * /api/v1/logs as a LogRecord; false (default) falls through to
   * captureMessage instead — matches bikeeper-go-sdk's Options.EnableLogging. */
  enableLogging?: boolean
  serverName?: string
  debug?: boolean
  beforeSend?: (event: EventPayload) => EventPayload | null
  onError?: (err: unknown) => void
  /** Runtime-specific context merged into every event (os/runtime/browser). */
  baseContexts?: Contexts
}

const SDK_INFO = { name: SDK_NAME, version: SDK_VERSION }

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error' | 'fatal'

const LOG_LEVEL_TO_EVENT_LEVEL: Record<LogLevelName, Level> = {
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  error: 'error',
  fatal: 'fatal',
}

export class LogEntryBuilder {
  private readonly tags: Record<string, string> = {}

  /** @internal */
  constructor(
    private readonly level: LogLevelName,
    private readonly emitFn: (level: LogLevelName, message: string, tags: Record<string, string>) => void,
  ) {}

  withTag(key: string, value: string): this {
    this.tags[key] = value
    return this
  }

  emit(message: string): void {
    this.emitFn(this.level, message, this.tags)
  }
}

export class BikeeperClient {
  private readonly staticTags: Record<string, string> = {}
  private readonly pending = new Set<Promise<void>>()

  constructor(private readonly opts: BikeeperClientOptions) {
    if (opts.environment) this.staticTags.environment = opts.environment
    if (opts.release) this.staticTags.release = opts.release
  }

  private currentState(): HubState {
    return this.opts.hubStore.getState()
  }

  private currentScope(): Scope {
    return this.currentState().scope
  }

  // ── Scope delegation ──────────────────────────────────────────────────

  setTag(key: string, value: string): void {
    this.currentScope().setTag(key, value)
  }

  removeTag(key: string): void {
    this.currentScope().removeTag(key)
  }

  setUser(user: UserInfo | undefined): void {
    this.currentScope().setUser(user)
  }

  setExtra(key: string, ctx: Record<string, unknown>): void {
    this.currentScope().setExtra(key, ctx)
  }

  setFingerprint(...parts: string[]): void {
    this.currentScope().setFingerprint(...parts)
  }

  setHTTPContext(info: HTTPRequestInfo): void {
    this.currentScope().setHTTPContext(info)
  }

  addBreadcrumb(input: BreadcrumbInput): void {
    this.currentScope().addBreadcrumb(input)
  }

  /** Runs `fn` against a clone of the current scope — mutations made inside
   * (setTag, setUser, addBreadcrumb, ...) are visible to fn and to anything
   * it calls, but never leak back out once withScope returns. Mirrors
   * bikeeper-go-sdk's Hub.WithScope. */
  withScope<T>(fn: (scope: Scope) => T): T {
    const state = cloneState(this.currentState())
    return this.opts.hubStore.runWithState(state, () => fn(state.scope))
  }

  // ── Capture ────────────────────────────────────────────────────────────

  private buildTags(extra?: Record<string, string>): Tag[] {
    const merged = { ...this.staticTags, ...this.currentScope().tags(), ...extra }
    return Object.keys(merged).map((key) => ({ key, value: merged[key] as string }))
  }

  private tagsOrUndefined(extra?: Record<string, string>): Tag[] | undefined {
    const tags = this.buildTags(extra)
    return tags.length > 0 ? tags : undefined
  }

  private activeTraceId(): string | undefined {
    return this.currentState().span?.traceId
  }

  /** Captures a caught exception. `handled: true` because the app code
   * chose to call this — as opposed to an uncaught error a global handler
   * routes here with handled: false. */
  captureException(err: unknown, extra?: CaptureExtra, handled = true): void {
    const scope = this.currentScope()
    const exception = toExceptionValue(err, handled)
    const message = messageOf(err)
    this.send({
      id: newEventId(),
      level: extra?.level ?? 'error',
      message,
      tags: this.tagsOrUndefined(extra?.tags),
      timestamp: nowISO(),
      url: extra?.url,
      trace_id: this.activeTraceId(),
      http_request: scope.httpRequest(),
      contexts: this.opts.baseContexts,
      sdk: SDK_INFO,
      exception,
      fingerprint: scope.fingerprint() ?? defaultFingerprint(message, exception),
      breadcrumbs: emptyToUndefined(scope.breadcrumbs()),
      user: scope.user(),
      extra: emptyMapToUndefined(scope.extra()),
    })
  }

  captureMessage(message: string, level: Level = 'info', extra?: CaptureExtra): void {
    const scope = this.currentScope()
    this.send({
      id: newEventId(),
      level,
      message,
      tags: this.tagsOrUndefined(extra?.tags),
      timestamp: nowISO(),
      url: extra?.url,
      trace_id: this.activeTraceId(),
      http_request: scope.httpRequest(),
      contexts: this.opts.baseContexts,
      sdk: SDK_INFO,
      fingerprint: scope.fingerprint() ?? defaultFingerprint(message),
      breadcrumbs: emptyToUndefined(scope.breadcrumbs()),
      user: scope.user(),
      extra: emptyMapToUndefined(scope.extra()),
    })
  }

  /** Low-level escape hatch: send a fully-built event as-is (still runs
   * through beforeSend and is tracked by flush()) — mirrors
   * bikeeper-go-sdk's Capture/CaptureEventAsync for callers who want full
   * control over the payload instead of the scope-driven capture* helpers. */
  captureEvent(event: EventPayload): Promise<void> {
    return this.dispatch(event)
  }

  /** Fire-and-forget send of a fully-built event — tracked so flush() can
   * wait for it, never throws (a broken transport must not surface as an
   * application error). */
  private send(event: EventPayload): void {
    void this.dispatch(event)
  }

  private dispatch(event: EventPayload): Promise<void> {
    const finalEvent = this.opts.beforeSend ? this.opts.beforeSend(event) : event
    if (!finalEvent) return Promise.resolve()
    const p = this.opts.transport.send({ kind: 'event', payload: finalEvent }).catch((err) => {
      this.opts.onError?.(err)
      if (this.opts.debug) console.error('[bikeeper] failed to send event', err)
    })
    this.track(p)
    return p
  }

  private track(p: Promise<void>): void {
    this.pending.add(p)
    void p.finally(() => this.pending.delete(p))
  }

  // ── Structured logging ────────────────────────────────────────────────

  debug(): LogEntryBuilder {
    return new LogEntryBuilder('debug', this.emitLog)
  }

  info(): LogEntryBuilder {
    return new LogEntryBuilder('info', this.emitLog)
  }

  warn(): LogEntryBuilder {
    return new LogEntryBuilder('warn', this.emitLog)
  }

  error(): LogEntryBuilder {
    return new LogEntryBuilder('error', this.emitLog)
  }

  fatal(): LogEntryBuilder {
    return new LogEntryBuilder('fatal', this.emitLog)
  }

  private emitLog = (level: LogLevelName, message: string, extraTags: Record<string, string>): void => {
    if (!this.opts.enableLogging) {
      this.captureMessage(message, LOG_LEVEL_TO_EVENT_LEVEL[level], { tags: extraTags })
      return
    }
    const record: LogRecordPayload = {
      id: newEventId(),
      level,
      message,
      tags: this.buildTags(extraTags),
      timestamp: nowISO(),
      sdk: SDK_INFO,
      environment: this.opts.environment,
      release: this.opts.release,
      server_name: this.opts.serverName,
    }
    const p = this.opts.transport.send({ kind: 'log', payload: record }).catch((err) => {
      this.opts.onError?.(err)
      if (this.opts.debug) console.error('[bikeeper] failed to send log', err)
    })
    this.track(p)
  }

  // ── Tracing ────────────────────────────────────────────────────────────

  /** Starts a new trace (or a child span of whatever's active) and finishes
   * it automatically around `fn`, marking it failed if `fn` throws.
   * Sampling is head-based: rolled once when a NEW trace starts; a child of
   * an already-sampled (or already-unsampled) trace inherits that decision. */
  async startSpan<T>(op: string, opts: SpanOptions, fn: (span: Span) => T | Promise<T>): Promise<T> {
    const state = this.currentState()
    const span = state.span
      ? Span.createChild(op, opts, state.span)
      : Span.createRoot(op, opts, Math.random() < (this.opts.tracesSampleRate ?? 0), this.opts.transport, SDK_INFO)
    return this.runSpan(state, span, fn)
  }

  /** Always starts a NEW trace, ignoring any currently active span — unlike
   * startSpan, which joins an in-flight trace as a child when one exists.
   * Mirrors bikeeper-go-sdk's distinct StartTransaction. */
  async startTransaction<T>(name: string, opts: SpanOptions, fn: (span: Span) => T | Promise<T>): Promise<T> {
    const state = this.currentState()
    const span = Span.createRoot(name, opts, Math.random() < (this.opts.tracesSampleRate ?? 0), this.opts.transport, SDK_INFO)
    return this.runSpan(state, span, fn)
  }

  private async runSpan<T>(state: HubState, span: Span, fn: (span: Span) => T | Promise<T>): Promise<T> {
    try {
      return await this.opts.hubStore.runWithState({ scope: state.scope, span }, () => fn(span))
    } catch (err) {
      span.setStatus('internal_error')
      throw err
    } finally {
      span.finish()
    }
  }

  getActiveSpan(): Span | undefined {
    return this.currentState().span
  }

  async flush(timeoutMs = 2000): Promise<void> {
    if (this.pending.size === 0) return
    await Promise.race([
      Promise.allSettled(Array.from(this.pending)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ])
  }
}

function emptyToUndefined<T>(arr: T[]): T[] | undefined {
  return arr.length > 0 ? arr : undefined
}

function emptyMapToUndefined<T extends object>(obj: T): T | undefined {
  return Object.keys(obj).length > 0 ? obj : undefined
}

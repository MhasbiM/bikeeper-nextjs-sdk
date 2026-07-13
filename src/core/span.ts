import type { SDKInfo, SpanPayload, SpanStatus, Tag, TransactionPayload } from './types'
import { newSpanId, newTraceId } from './util'
import type { Transport } from './transport'

interface TransactionState {
  root: Span
  children: Span[]
  sampled: boolean
  transport?: Transport
  sdk: SDKInfo
}

export type TransactionSource = 'url' | 'route' | 'view' | 'task' | 'custom'

export interface SpanOptions {
  description?: string
  tags?: Record<string, string>
  /** Only meaningful on a root span (transaction) — mirrors
   * bikeeper-go-sdk's WithTransactionSource. Not part of the wire payload
   * (Go's own TransactionPayload doesn't serialize it either); recorded as
   * a `transaction_source` tag so it's still visible on the event. */
  transactionSource?: TransactionSource
}

function toTagList(tags: Record<string, string>): Tag[] | undefined {
  const keys = Object.keys(tags)
  if (keys.length === 0) return undefined
  return keys.map((key) => ({ key, value: tags[key] as string }))
}

export class Span {
  readonly spanId: string
  readonly traceId: string
  readonly parentSpanId?: string
  op: string
  description?: string
  status?: SpanStatus
  readonly tags: Record<string, string> = {}
  readonly data: Record<string, unknown> = {}
  private readonly startMs: number
  private endMs?: number
  /** @internal */
  readonly txn: TransactionState

  private constructor(op: string, opts: SpanOptions | undefined, parent: Span | undefined, txn: TransactionState | undefined) {
    this.op = op
    this.description = opts?.description
    if (opts?.tags) Object.assign(this.tags, opts.tags)
    if (opts?.transactionSource) this.tags.transaction_source = opts.transactionSource
    this.startMs = Date.now()
    this.spanId = newSpanId()

    if (parent) {
      this.traceId = parent.traceId
      this.parentSpanId = parent.spanId
      this.txn = parent.txn
    } else {
      this.traceId = newTraceId()
      this.txn = txn ?? { root: this, children: [], sampled: false, sdk: { name: 'bikeeper-nextjs', version: '0.1.0' } }
    }
  }

  /** @internal */
  static createRoot(op: string, opts: SpanOptions | undefined, sampled: boolean, transport: Transport | undefined, sdk: SDKInfo): Span {
    const txn: TransactionState = { root: undefined as unknown as Span, children: [], sampled, transport, sdk }
    const span = new Span(op, opts, undefined, txn)
    txn.root = span
    return span
  }

  /** @internal */
  static createChild(op: string, opts: SpanOptions | undefined, parent: Span): Span {
    const span = new Span(op, opts, parent, undefined)
    parent.txn.children.push(span)
    return span
  }

  setTag(key: string, value: string): this {
    this.tags[key] = value
    return this
  }

  setData(key: string, value: unknown): this {
    this.data[key] = value
    return this
  }

  setStatus(status: SpanStatus): this {
    this.status = status
    return this
  }

  setHttpStatus(code: number): this {
    this.tags['http.status_code'] = String(code)
    if (code >= 500) this.status = 'internal_error'
    else if (code === 404) this.status = 'not_found'
    else if (code >= 400) this.status = 'error'
    else this.status = 'ok'
    return this
  }

  get isRoot(): boolean {
    return this.txn.root === this
  }

  /** Idempotent — safe to call more than once (e.g. once on error, once via
   * an enclosing try/finally). Only the root span's Finish actually builds
   * and sends the transaction payload; a non-root Finish just records the
   * end time. */
  finish(): void {
    if (this.endMs !== undefined) return
    this.endMs = Date.now()
    if (!this.isRoot) return
    if (!this.txn.sampled || !this.txn.transport) return

    const payload = buildTransactionPayload(this, this.txn)
    this.txn.transport.send({ kind: 'transaction', payload }).catch(() => {
      // Best-effort telemetry — a failed transaction send must never
      // surface as an application error.
    })
  }

  /** @internal */
  get durationNs(): number {
    return ((this.endMs ?? Date.now()) - this.startMs) * 1_000_000
  }

  /** @internal */
  toSpanPayload(txnStartMs: number): SpanPayload {
    return {
      span_id: this.spanId,
      parent_span_id: this.parentSpanId,
      op: this.op,
      description: this.description,
      status: this.status,
      start_offset: (this.startMs - txnStartMs) * 1_000_000,
      duration: this.durationNs,
      tags: toTagList(this.tags),
      data: Object.keys(this.data).length > 0 ? this.data : undefined,
    }
  }

  /** @internal */
  get startTimeMs(): number {
    return this.startMs
  }

  /** @internal */
  get isFinished(): boolean {
    return this.endMs !== undefined
  }
}

function buildTransactionPayload(root: Span, txn: TransactionState): TransactionPayload {
  // A child that hasn't finished yet when the root sends is dropped rather
  // than included half-formed — same rule bikeeper-go-sdk applies.
  const spans = txn.children.filter((c) => c.isFinished).map((c) => c.toSpanPayload(root.startTimeMs))
  return {
    span_id: root.spanId,
    trace_id: root.traceId,
    op: root.op,
    description: root.description,
    status: root.status,
    start_time: new Date(root.startTimeMs).toISOString(),
    duration: root.durationNs,
    tags: toTagList(root.tags),
    sdk: txn.sdk,
    spans,
  }
}

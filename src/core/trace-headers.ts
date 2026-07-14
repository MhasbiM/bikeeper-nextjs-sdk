import type { Span } from './span'

const TRACEPARENT_VERSION = '00'
const ZERO_TRACE_ID = '0'.repeat(32)
const ZERO_SPAN_ID = '0'.repeat(16)

/** Builds a W3C Trace Context traceparent header
 * (https://www.w3.org/TR/trace-context/) for the given span, so an
 * outgoing HTTP call can be correlated with this trace by whatever's on
 * the other end — another Bikeeper-instrumented service, or any
 * W3C-compatible tracing tool. Returns undefined if there's no active span
 * to attach (nothing to propagate). */
export function traceparentFor(span: Span | undefined): string | undefined {
  if (!span) return undefined
  return `${TRACEPARENT_VERSION}-${span.traceId}-${span.spanId}-01`
}

export interface IncomingTraceContext {
  traceId: string
  parentSpanId: string
}

/** Parses an incoming traceparent header — returns undefined if missing or
 * malformed, in which case the caller should just start a fresh trace
 * rather than fail the request over a bad header. */
export function parseTraceparent(header: string | null | undefined): IncomingTraceContext | undefined {
  if (!header) return undefined
  const parts = header.split('-')
  if (parts.length !== 4) return undefined
  const [version, traceId, spanId] = parts as [string, string, string, string]
  if (version !== TRACEPARENT_VERSION) return undefined
  if (!/^[0-9a-f]{32}$/.test(traceId) || traceId === ZERO_TRACE_ID) return undefined
  if (!/^[0-9a-f]{16}$/.test(spanId) || spanId === ZERO_SPAN_ID) return undefined
  return { traceId, parentSpanId: spanId }
}

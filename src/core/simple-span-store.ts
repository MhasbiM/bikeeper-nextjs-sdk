import type { Span, SpanContextStore } from './span'

/** Browser fallback span store — a plain module-scoped variable. The
 * browser's main thread is single-threaded so this is correct for the
 * common case (one navigation/interaction traced at a time), but unlike
 * AsyncSpanStore it does NOT give each concurrently-awaited async chain its
 * own isolated "active span" — two overlapping traced operations on the
 * same page can have their spans attributed to whichever finished starting
 * last. Acceptable for v1 client-side tracing (page loads, one fetch at a
 * time); revisit if concurrent client-side traces become common. */
export class SimpleSpanStore implements SpanContextStore {
  private active: Span | undefined

  getActive(): Span | undefined {
    return this.active
  }

  runWithActive<T>(span: Span, fn: () => T): T {
    const previous = this.active
    this.active = span
    try {
      return fn()
    } finally {
      this.active = previous
    }
  }
}

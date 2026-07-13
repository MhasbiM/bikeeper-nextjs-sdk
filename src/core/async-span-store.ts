import { AsyncLocalStorage } from 'node:async_hooks'
import type { Span, SpanContextStore } from './span'

/** Per-request span isolation for Node.js and Next.js Edge runtime (both
 * expose node:async_hooks' AsyncLocalStorage) — correct even when many
 * requests run concurrently in the same process/isolate, unlike a plain
 * module-scoped variable. */
export class AsyncSpanStore implements SpanContextStore {
  private readonly als = new AsyncLocalStorage<Span>()

  getActive(): Span | undefined {
    return this.als.getStore()
  }

  runWithActive<T>(span: Span, fn: () => T): T {
    return this.als.run(span, fn)
  }
}

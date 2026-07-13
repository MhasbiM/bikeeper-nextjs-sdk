import { AsyncLocalStorage } from 'node:async_hooks'
import { Scope } from './scope'
import type { HubState, HubStore } from './hub-store'

/** Per-request isolation for Node.js and Next.js Edge runtime (both expose
 * node:async_hooks' AsyncLocalStorage) — each concurrent request gets its
 * own Scope (tags/user/breadcrumbs/etc.) and active Span, correctly, even
 * when many requests run concurrently in the same process/isolate. */
export class AsyncHubStore implements HubStore {
  private readonly als = new AsyncLocalStorage<HubState>()
  private readonly rootScope = new Scope()

  getState(): HubState {
    return this.als.getStore() ?? { scope: this.rootScope }
  }

  runWithState<T>(state: HubState, fn: () => T): T {
    return this.als.run(state, fn)
  }
}

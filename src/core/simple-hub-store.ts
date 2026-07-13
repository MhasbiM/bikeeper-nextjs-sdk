import { Scope } from './scope'
import type { HubState, HubStore } from './hub-store'

/** Browser fallback — a plain module-scoped variable. See the equivalent
 * caveat this used to carry as SimpleSpanStore: correct for one traced
 * operation at a time (a page load, one fetch), not true per-async-chain
 * isolation. For a single browser tab (one user, not concurrent unrelated
 * requests like a server), a single cumulative Scope is actually the right
 * default — breadcrumbs accumulating across the page's lifetime is the
 * useful behavior, not something to isolate away. */
export class SimpleHubStore implements HubStore {
  private state: HubState = { scope: new Scope() }

  getState(): HubState {
    return this.state
  }

  runWithState<T>(state: HubState, fn: () => T): T {
    const previous = this.state
    this.state = state
    try {
      return fn()
    } finally {
      this.state = previous
    }
  }
}

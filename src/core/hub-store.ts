import type { Span } from './span'
import { Scope } from './scope'

export interface HubState {
  scope: Scope
  span?: Span
}

/** Where the "currently active request" (scope + span) is tracked. */
export interface HubStore {
  getState(): HubState
  runWithState<T>(state: HubState, fn: () => T): T
}

export function cloneState(state: HubState): HubState {
  return { scope: state.scope.clone(), span: state.span }
}

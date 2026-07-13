import { Component, type ErrorInfo, type ReactNode } from 'react'
import { captureException } from './index'

export interface BikeeperErrorBoundaryProps {
  children: ReactNode
  fallback: ReactNode | ((error: unknown, reset: () => void) => ReactNode)
}

interface State {
  error: unknown
}

/** Catches render errors in the wrapped React subtree, reports them to
 * Bikeeper, and renders `fallback` instead of unmounting the whole tree.
 * Next.js's own `error.tsx` file convention already does this at the route
 * segment level — use this component for finer-grained boundaries inside a
 * page (a single widget/panel) where you don't want one broken component to
 * take down the whole route. */
export class BikeeperErrorBoundary extends Component<BikeeperErrorBoundaryProps, State> {
  state: State = { error: undefined }

  static getDerivedStateFromError(error: unknown): State {
    return { error }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    captureException(error, { tags: { component_stack: info.componentStack ?? '' } })
  }

  private reset = (): void => {
    this.setState({ error: undefined })
  }

  render(): ReactNode {
    if (this.state.error !== undefined) {
      return typeof this.props.fallback === 'function' ? this.props.fallback(this.state.error, this.reset) : this.props.fallback
    }
    return this.props.children
  }
}

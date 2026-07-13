import type { ExceptionValue } from './types'

/** Default grouping fingerprint: exception type + the first in-app frame,
 * falling back to the message alone for non-exception events. Mirrors
 * bikeeper-go-sdk's grouping approach (same error at the same call site
 * groups into one issue regardless of request-specific values in the
 * message). */
export function defaultFingerprint(message: string, exception?: ExceptionValue): string[] {
  if (exception?.type) {
    const topFrame = exception.stacktrace?.frames?.slice().reverse().find((f) => f.in_app)
    if (topFrame) {
      return [exception.type, topFrame.function ?? topFrame.filename ?? '?', String(topFrame.line ?? '')]
    }
    return [exception.type, exception.value ?? '']
  }
  return [message]
}

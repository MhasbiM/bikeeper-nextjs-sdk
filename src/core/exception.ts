import { parseStacktrace } from './stacktrace'
import type { ExceptionValue } from './types'

/** Normalizes anything that can be thrown/rejected in JS (Error, string,
 * plain object, etc.) into Bikeeper's ExceptionValue wire shape. */
export function toExceptionValue(err: unknown, handled: boolean): ExceptionValue {
  if (err instanceof Error) {
    return {
      type: err.name || 'Error',
      value: err.message,
      stacktrace: parseStacktrace(err),
      mechanism: { handled },
    }
  }
  if (typeof err === 'string') {
    return { type: 'Error', value: err, mechanism: { handled } }
  }
  try {
    return { type: 'Error', value: JSON.stringify(err), mechanism: { handled } }
  } catch {
    return { type: 'Error', value: String(err), mechanism: { handled } }
  }
}

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

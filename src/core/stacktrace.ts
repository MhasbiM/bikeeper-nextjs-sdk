import type { StackFrame, Stacktrace } from './types'

// Matches V8 (Node.js, Chrome): "    at fnName (file:line:col)" or "    at file:line:col"
const V8_LINE = /^\s*at\s+(?:(.*?)\s+\()?(?:(.*?):(\d+):(\d+)|(native))\)?\s*$/
// Matches Firefox/Safari: "fnName@file:line:col" or "@file:line:col"
const GECKO_LINE = /^(.*?)@(.*?):(\d+):(\d+)$/

function parseLine(line: string): StackFrame | null {
  let m = V8_LINE.exec(line)
  if (m) {
    const [, fn, file, lineNo, , native] = m
    if (native) return { function: fn || undefined, module: 'native', in_app: false }
    if (!file) return null
    return {
      function: fn || undefined,
      filename: file,
      line: lineNo ? Number(lineNo) : undefined,
      in_app: isInApp(file),
    }
  }
  m = GECKO_LINE.exec(line)
  if (m) {
    const [, fn, file, lineNo] = m
    return {
      function: fn || undefined,
      filename: file,
      line: lineNo ? Number(lineNo) : undefined,
      in_app: isInApp(file ?? ''),
    }
  }
  return null
}

function isInApp(filename: string): boolean {
  return !/node_modules|^node:|\(native\)/.test(filename)
}

/** Parses an Error's .stack string into Bikeeper's StackFrame[] shape.
 * Best-effort: unrecognized lines are skipped rather than failing the whole
 * capture. Frame order is reversed to outermost-first, matching how
 * bikeeper-go-sdk and the dashboard render Go stacktraces. */
export function parseStacktrace(err: unknown): Stacktrace | undefined {
  if (!(err instanceof Error) || typeof err.stack !== 'string') return undefined
  const lines = err.stack.split('\n').slice(1) // drop the "Error: message" header line
  const frames: StackFrame[] = []
  for (const line of lines) {
    const frame = parseLine(line)
    if (frame) frames.push(frame)
  }
  if (frames.length === 0) return undefined
  frames.reverse()
  return { frames }
}

// Wire types mirror bikeeper-go-sdk's Event/LogRecord/TransactionPayload
// structs field-for-field (same JSON keys) so this SDK's payloads are
// byte-compatible with what the Bikeeper backend already parses.

export type Level = 'debug' | 'info' | 'warning' | 'error' | 'fatal'

export interface Tag {
  key: string
  value: string
}

export interface UserInfo {
  id?: string
  email?: string
  name?: string
  ip_address?: string
}

export interface HTTPRequestInfo {
  method?: string
  url?: string
  query_string?: string
  data?: string
  headers?: Record<string, string>
  env?: Record<string, string>
}

export interface BrowserInfo {
  name?: string
  version?: string
}

export interface RuntimeInfo {
  name?: string
  version?: string
}

export interface OSInfo {
  name?: string
  version?: string
  build?: string
  kernel_version?: string
}

export interface DeviceInfo {
  name?: string
  family?: string
  model?: string
  arch?: string
}

export interface TraceInfo {
  trace_id?: string
  span_id?: string
  parent_span_id?: string
  op?: string
  description?: string
}

export interface Contexts {
  browser?: BrowserInfo
  runtime?: RuntimeInfo
  os?: OSInfo
  client_os?: OSInfo
  device?: DeviceInfo
  trace?: TraceInfo
}

export interface SDKInfo {
  name: string
  version: string
}

export interface PackageInfo {
  name: string
  version: string
}

export interface ContextLine {
  line: number
  code: string
  is_current: boolean
}

export interface StackFrame {
  function?: string
  module?: string
  filename?: string
  line?: number
  in_app: boolean
  context?: ContextLine[]
}

export interface Stacktrace {
  frames?: StackFrame[]
}

export interface ExceptionMechanism {
  type?: string
  handled: boolean
}

export interface ExceptionValue {
  type?: string
  value?: string
  stacktrace?: Stacktrace
  mechanism?: ExceptionMechanism
}

export interface Breadcrumb {
  timestamp: string
  type?: string
  category?: string
  message: string
  level: Level
  data?: Record<string, unknown>
}

/** Wire shape POSTed to /api/v1/ingest. */
export interface EventPayload {
  id: string
  level: Level
  message: string
  tags?: Tag[]
  timestamp: string
  url?: string
  trace_id?: string
  http_request?: HTTPRequestInfo
  contexts?: Contexts
  packages?: PackageInfo[]
  sdk?: SDKInfo
  exception?: ExceptionValue
  fingerprint?: string[]
  breadcrumbs?: Breadcrumb[]
}

/** Wire shape POSTed to /api/v1/logs. */
export interface LogRecordPayload {
  id: string
  level: string
  message: string
  tags: Tag[]
  timestamp: string
  sdk?: SDKInfo
  environment?: string
  release?: string
  server_name?: string
}

export type SpanStatus = 'ok' | 'error' | 'internal_error' | 'not_found' | 'unknown'

export interface SpanPayload {
  span_id: string
  parent_span_id?: string
  op: string
  description?: string
  status?: SpanStatus
  /** Nanoseconds since the transaction's start_time — an integer, matching
   * how Go's time.Duration marshals (NOT an ISO 8601 string). */
  start_offset: number
  /** Nanoseconds, same integer convention as start_offset. */
  duration: number
  tags?: Tag[]
  data?: Record<string, unknown>
}

/** Wire shape POSTed to /api/v1/transactions. */
export interface TransactionPayload {
  span_id: string
  trace_id: string
  op: string
  description?: string
  status?: SpanStatus
  start_time: string
  /** Nanoseconds, integer — see SpanPayload.duration. */
  duration: number
  tags?: Tag[]
  sdk?: SDKInfo
  spans?: SpanPayload[]
}

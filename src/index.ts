// Isomorphic surface — types only, safe to import from any file (shared
// code, "use client" components, server code alike). Runtime code lives
// behind the runtime-specific entry points below, since client vs
// server/edge need different transports and must never share a bundle:
//
//   import * as Bikeeper from 'bikeeper-nextjs-sdk/client'  // browser
//   import * as Bikeeper from 'bikeeper-nextjs-sdk/server'  // Node.js runtime
//   import * as Bikeeper from 'bikeeper-nextjs-sdk/edge'    // Edge runtime / middleware
//   import { createBikeeperTunnelRouteHandler } from 'bikeeper-nextjs-sdk/tunnel'

export { SDK_NAME, SDK_VERSION } from './core/constants'
export { DEFAULT_TUNNEL_URL } from './core/options'
export type { ClientOptions, ServerOptions } from './core/options'
export type {
  Breadcrumb,
  Contexts,
  EventPayload,
  ExceptionValue,
  Level,
  LogRecordPayload,
  SpanPayload,
  SpanStatus,
  Tag,
  TransactionPayload,
  UserInfo,
} from './core/types'

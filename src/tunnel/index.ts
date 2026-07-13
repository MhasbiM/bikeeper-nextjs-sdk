import 'server-only'

import type { ServerOptions } from '../core/options'
import { DirectTransport, type WirePayload } from '../core/transport'

const MAX_BODY_BYTES = 256 * 1024
const VALID_KINDS = new Set(['event', 'log', 'transaction'])

function isWirePayload(body: unknown): body is WirePayload {
  return (
    typeof body === 'object' &&
    body !== null &&
    'kind' in body &&
    'payload' in body &&
    VALID_KINDS.has((body as { kind: unknown }).kind as string) &&
    typeof (body as { payload: unknown }).payload === 'object'
  )
}

/**
 * Creates a Route Handler that the browser SDK posts to instead of talking
 * to Bikeeper directly — this is the ONLY place in a Next.js app that
 * should hold real Bikeeper credentials for browser-originated telemetry,
 * since embedding them in client JS would let anyone extract them from the
 * bundle and flood/forge your project's events.
 *
 * Mount it at the path you pass as `tunnelUrl` to the browser SDK's init()
 * (default "/monitoring/bikeeper"):
 *
 *   // app/monitoring/bikeeper/route.ts
 *   import { createBikeeperTunnelRouteHandler } from 'bikeeper-nextjs-sdk/tunnel'
 *   export const { POST } = createBikeeperTunnelRouteHandler({
 *     clientId: process.env.BIKEEPER_CLIENT_ID!,
 *     clientSecret: process.env.BIKEEPER_CLIENT_SECRET!,
 *     projectId: process.env.BIKEEPER_PROJECT_ID!,
 *     endpoint: process.env.BIKEEPER_ENDPOINT,
 *   })
 */
export function createBikeeperTunnelRouteHandler(options: ServerOptions): { POST: (req: Request) => Promise<Response> } {
  const transport = new DirectTransport({
    endpoint: options.endpoint,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    projectId: options.projectId,
    timeoutMs: options.timeoutMs,
  })

  async function POST(req: Request): Promise<Response> {
    const contentLength = Number(req.headers.get('content-length') ?? '0')
    if (contentLength > MAX_BODY_BYTES) {
      return new Response('payload too large', { status: 413 })
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return new Response('invalid json body', { status: 400 })
    }

    if (!isWirePayload(body)) {
      return new Response('invalid tunnel payload shape', { status: 400 })
    }

    try {
      await transport.send(body)
    } catch (err) {
      options.onError?.(err)
      if (options.debug) console.error('[bikeeper] tunnel forward failed', err)
      return new Response('upstream forward failed', { status: 502 })
    }

    return new Response(null, { status: 202 })
  }

  return { POST }
}

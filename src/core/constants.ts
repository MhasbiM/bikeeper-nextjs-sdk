export const SDK_NAME = 'bikeeper-nextjs'
export const SDK_VERSION = '0.1.0'

export const DEFAULT_ENDPOINT = 'http://localhost:8080'
export const DEFAULT_TIMEOUT_MS = 5000

export const INGEST_PATH = '/api/v1/ingest'
export const LOGS_PATH = '/api/v1/logs'
export const TRANSACTIONS_PATH = '/api/v1/transactions'

export const HEADER_CLIENT_ID = 'X-Bikeeper-Client-ID'
export const HEADER_CLIENT_SECRET = 'X-Bikeeper-Client-Secret'
export const HEADER_PROJECT_ID = 'X-Bikeeper-Project-ID'
export const HEADER_SDK_FRAMEWORK = 'X-Bikeeper-SDK-Framework'

/** Sent as X-Bikeeper-SDK-Framework on every /api/v1/ingest call — the Go
 * backend's transport requires this header to be non-empty (it was designed
 * around bikeeperfiber/bikeeperecho always setting it); Next.js has no single
 * "framework" so this SDK reports itself as the framework. */
export const SDK_FRAMEWORK = 'nextjs'

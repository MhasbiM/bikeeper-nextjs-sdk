function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  const webCrypto: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(arr)
  } else {
    for (let i = 0; i < bytes; i++) arr[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 128-bit trace id, matching bikeeper-go-sdk's 32 hex char TraceID. */
export function newTraceId(): string {
  return randomHex(16)
}

/** 64-bit span id, matching bikeeper-go-sdk's 16 hex char SpanID. */
export function newSpanId(): string {
  return randomHex(8)
}

/** Event id — Bikeeper's Event.ID is a free-form string; a full 128-bit id
 * (no dashes) matches bikeeper-go-sdk's convention of a UUID-shaped string. */
export function newEventId(): string {
  return randomHex(16)
}

export function nowISO(): string {
  return new Date().toISOString()
}

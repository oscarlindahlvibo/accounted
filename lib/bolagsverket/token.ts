import { createLogger } from '@/lib/logger'
import { getBolagsverketConfig } from './env'

const log = createLogger('bolagsverket.token')

// Mint a new token this long before actual expiry, so a request in flight
// never races a token that dies mid-call.
const REFRESH_MARGIN_MS = 60_000
const TOKEN_FETCH_TIMEOUT_MS = 10_000

export class BolagsverketAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BolagsverketAuthError'
  }
}

interface CachedToken {
  accessToken: string
  expiresAt: number
}

let cached: CachedToken | null = null
let inFlight: Promise<string> | null = null

/** Test-only: reset in-process token cache between test cases. */
export function __resetBolagsverketTokenCacheForTests(): void {
  cached = null
  inFlight = null
}

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

async function mintToken(): Promise<string> {
  const config = getBolagsverketConfig()

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  })

  let response: Response
  try {
    response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    log.warn('token request failed', { error: message, timeout: isTimeout })
    throw new BolagsverketAuthError(
      isTimeout ? 'Bolagsverket token endpoint timed out.' : 'Bolagsverket token endpoint unreachable.',
    )
  }

  // Read the body once as text so we can log a bounded, secret-free excerpt
  // on parse failure without ever echoing client_secret (never sent back by
  // the token endpoint) or a token value.
  const text = await response.text()

  if (!response.ok) {
    let parsed: TokenResponse = {}
    try {
      parsed = JSON.parse(text) as TokenResponse
    } catch {
      // non-JSON error body: fall through with the status only
    }
    log.warn('token request rejected', {
      status: response.status,
      error: parsed.error,
    })
    if (response.status === 401 || response.status === 403) {
      throw new BolagsverketAuthError('Bolagsverket rejected the client credentials.')
    }
    throw new BolagsverketAuthError(`Bolagsverket token endpoint returned ${response.status}.`)
  }

  let parsed: TokenResponse
  try {
    parsed = JSON.parse(text) as TokenResponse
  } catch {
    throw new BolagsverketAuthError('Bolagsverket token endpoint returned invalid JSON.')
  }
  if (!parsed.access_token) {
    throw new BolagsverketAuthError('Bolagsverket token endpoint returned no access_token.')
  }

  const expiresInSec = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600
  cached = { accessToken: parsed.access_token, expiresAt: Date.now() + expiresInSec * 1000 }
  return cached.accessToken
}

/**
 * Get a cached, valid Bolagsverket access token, minting a new one only
 * when the cache is empty or within REFRESH_MARGIN_MS of expiry. Concurrent
 * callers during a mint share the same in-flight request (no thundering
 * herd against the token endpoint).
 */
export async function getBolagsverketAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return cached.accessToken
  }
  if (inFlight) return inFlight

  inFlight = mintToken().finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Drop the cached token (call after a 401 from an API request). */
export function invalidateBolagsverketToken(): void {
  cached = null
}

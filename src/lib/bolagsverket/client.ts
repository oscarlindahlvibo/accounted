import crypto from 'crypto'
import { createLogger } from '@/lib/logger'
import { getBolagsverketConfig, isBolagsverketConfigured } from './env'
import { getBolagsverketAccessToken, invalidateBolagsverketToken } from './token'
import type { BvApiError } from './types'

const log = createLogger('bolagsverket.client')

const REQUEST_TIMEOUT_MS = 15_000
const MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 300

export type BolagsverketErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH_FAILED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_ERROR'

export class BolagsverketApiError extends Error {
  code: BolagsverketErrorCode
  status?: number
  requestId?: string

  constructor(code: BolagsverketErrorCode, message: string, status?: number, requestId?: string) {
    super(message)
    this.name = 'BolagsverketApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  /** Parse the response as JSON (default) or return the raw Response for binary payloads. */
  raw?: boolean
}

/**
 * Low-level authenticated request to a Bolagsverket VärdefullaDatamängder
 * endpoint. Handles token attach, X-Request-Id, timeout, and retry with
 * backoff for 429/5xx/network errors. Never logs the access token or
 * client_secret — only status codes, error codes and request IDs.
 */
export async function bolagsverketRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T | Response> {
  if (!isBolagsverketConfigured()) {
    throw new BolagsverketApiError('NOT_CONFIGURED', 'Bolagsverket credentials are not configured.')
  }
  const config = getBolagsverketConfig()
  const { method = 'GET', body, raw = false } = options
  const requestId = crypto.randomUUID()
  const url = `${config.apiBaseUrl}${path}`

  let lastError: BolagsverketApiError | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = Date.now()
    let token: string
    try {
      token = await getBolagsverketAccessToken()
    } catch (err) {
      log.warn('token acquisition failed', { path, requestId })
      throw new BolagsverketApiError(
        'AUTH_FAILED',
        err instanceof Error ? err.message : 'Could not obtain Bolagsverket access token.',
      )
    }

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Request-Id': requestId,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
      lastError = new BolagsverketApiError(
        isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        isTimeout ? 'Bolagsverket request timed out.' : 'Bolagsverket request failed (network error).',
      )
      log.warn('request failed', {
        path,
        requestId,
        attempt,
        code: lastError.code,
        durationMs: Date.now() - startedAt,
      })
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt)
        continue
      }
      throw lastError
    }

    log.info('request completed', {
      path,
      requestId,
      attempt,
      status: response.status,
      durationMs: Date.now() - startedAt,
    })

    if (response.status === 401) {
      // Token may have been revoked/rotated server-side: drop the cache and
      // retry once with a freshly minted token before giving up.
      invalidateBolagsverketToken()
      if (attempt < MAX_RETRIES) continue
      throw new BolagsverketApiError('AUTH_FAILED', 'Bolagsverket rejected the access token.', 401, requestId)
    }

    if (response.status === 429) {
      lastError = new BolagsverketApiError('RATE_LIMITED', 'Bolagsverket rate limit exceeded.', 429, requestId)
      if (attempt < MAX_RETRIES) {
        const retryAfterHeader = response.headers.get('Retry-After')
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null
        await sleep(retryAfterMs && !Number.isNaN(retryAfterMs) ? retryAfterMs : RETRY_BASE_DELAY_MS * 2 ** attempt)
        continue
      }
      throw lastError
    }

    if (response.status >= 500) {
      lastError = new BolagsverketApiError(
        'UPSTREAM_ERROR',
        `Bolagsverket returned ${response.status}.`,
        response.status,
        requestId,
      )
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt)
        continue
      }
      throw lastError
    }

    if (response.status === 404) {
      throw new BolagsverketApiError('NOT_FOUND', 'Not found.', 404, requestId)
    }

    if (!response.ok) {
      const apiError = await safeParseApiError(response)
      throw new BolagsverketApiError(
        'UPSTREAM_ERROR',
        apiError?.detail || apiError?.title || `Bolagsverket returned ${response.status}.`,
        response.status,
        requestId,
      )
    }

    if (raw) return response
    return (await response.json()) as T
  }

  // Unreachable in practice (the loop always returns or throws), but keeps
  // the function's return type honest for TypeScript.
  throw lastError ?? new BolagsverketApiError('NETWORK_ERROR', 'Bolagsverket request failed.')
}

async function safeParseApiError(response: Response): Promise<BvApiError | null> {
  try {
    return (await response.json()) as BvApiError
  } catch {
    return null
  }
}

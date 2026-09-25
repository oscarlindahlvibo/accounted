/**
 * Bolagsverket "Värdefulla datamängder" configuration.
 *
 * Endpoints verified 2026-08-27 against the acceptance environment's own
 * published OpenAPI spec (portal-accept2.api.bolagsverket.se, API
 * VärdefullaDatamängder v1) and the credentials/URLs Bolagsverket issued us:
 *   - Base API URL:  https://gw-accept2.api.bolagsverket.se/vardefulla-datamangder/v1
 *   - Token URL:     https://portal-accept2.api.bolagsverket.se/oauth2/token
 *     (as given to us; the OpenAPI spec's own `tokenUrl` is the relative
 *     path `/oauth2/token`, consistent with this host)
 *
 * Production URLs are NOT guessed: Bolagsverket's public docs and the
 * acceptance OpenAPI spec do not state them, so BOLAGSVERKET_API_BASE_URL
 * and BOLAGSVERKET_TOKEN_URL become REQUIRED overrides once
 * BOLAGSVERKET_ENV=production — getBolagsverketConfig() throws a clear
 * config error rather than inventing a hostname.
 */

export type BolagsverketEnv = 'acceptance' | 'production'

const ACCEPTANCE_API_BASE_URL = 'https://gw-accept2.api.bolagsverket.se/vardefulla-datamangder/v1'
const ACCEPTANCE_TOKEN_URL = 'https://portal-accept2.api.bolagsverket.se/oauth2/token'

export interface BolagsverketConfig {
  env: BolagsverketEnv
  clientId: string
  clientSecret: string
  apiBaseUrl: string
  tokenUrl: string
}

export class BolagsverketConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BolagsverketConfigError'
  }
}

function getEnv(): BolagsverketEnv {
  const raw = (process.env.BOLAGSVERKET_ENV ?? 'acceptance').toLowerCase()
  return raw === 'production' ? 'production' : 'acceptance'
}

/** True once client_id/client_secret are present, regardless of environment. */
export function isBolagsverketConfigured(): boolean {
  return Boolean(process.env.BOLAGSVERKET_CLIENT_ID && process.env.BOLAGSVERKET_CLIENT_SECRET)
}

/**
 * Resolve full configuration or throw BolagsverketConfigError with a
 * message naming exactly which env var is missing. Never falls back to a
 * guessed production URL.
 */
export function getBolagsverketConfig(): BolagsverketConfig {
  const env = getEnv()
  const clientId = process.env.BOLAGSVERKET_CLIENT_ID
  const clientSecret = process.env.BOLAGSVERKET_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new BolagsverketConfigError(
      'BOLAGSVERKET_CLIENT_ID and BOLAGSVERKET_CLIENT_SECRET are required.',
    )
  }

  const apiBaseUrl = process.env.BOLAGSVERKET_API_BASE_URL || (env === 'acceptance' ? ACCEPTANCE_API_BASE_URL : null)
  const tokenUrl = process.env.BOLAGSVERKET_TOKEN_URL || (env === 'acceptance' ? ACCEPTANCE_TOKEN_URL : null)

  if (!apiBaseUrl) {
    throw new BolagsverketConfigError(
      'BOLAGSVERKET_API_BASE_URL is required when BOLAGSVERKET_ENV=production: ' +
        'the production base URL is not published in Bolagsverket’s acceptance ' +
        'documentation and must be confirmed with Bolagsverket directly, not guessed.',
    )
  }
  if (!tokenUrl) {
    throw new BolagsverketConfigError(
      'BOLAGSVERKET_TOKEN_URL is required when BOLAGSVERKET_ENV=production, for the same reason.',
    )
  }

  return { env, clientId, clientSecret, apiBaseUrl, tokenUrl }
}

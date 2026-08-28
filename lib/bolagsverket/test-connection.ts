import { isBolagsverketConfigured, getBolagsverketConfig } from './env'
import { getBolagsverketAccessToken } from './token'
import { bolagsverketRequest, BolagsverketApiError } from './client'

export interface BolagsverketConnectionCheck {
  ok: boolean
  environment: 'acceptance' | 'production' | null
  steps: {
    credentialsConfigured: boolean
    tokenAcquired: boolean
    apiReachable: boolean
  }
  /** User-facing, English/Swedish-neutral message; never a token or secret. */
  message: string
}

/**
 * Settings → "Testa anslutning". Checks, in order: credentials present,
 * a Client Credentials token can be minted, and the API answers /isalive.
 * Never returns a token or credential value.
 */
export async function testBolagsverketConnection(): Promise<BolagsverketConnectionCheck> {
  if (!isBolagsverketConfigured()) {
    return {
      ok: false,
      environment: null,
      steps: { credentialsConfigured: false, tokenAcquired: false, apiReachable: false },
      message: 'BOLAGSVERKET_CLIENT_ID / BOLAGSVERKET_CLIENT_SECRET saknas.',
    }
  }

  const { env } = getBolagsverketConfig()

  try {
    await getBolagsverketAccessToken()
  } catch (err) {
    return {
      ok: false,
      environment: env,
      steps: { credentialsConfigured: true, tokenAcquired: false, apiReachable: false },
      message:
        err instanceof Error && err.name === 'BolagsverketAuthError'
          ? `Client credentials avvisades: ${err.message}`
          : 'Kunde inte hämta access token från Bolagsverket.',
    }
  }

  try {
    await bolagsverketRequest('/isalive', { method: 'GET', raw: true })
  } catch (err) {
    const code = err instanceof BolagsverketApiError ? err.code : 'NETWORK_ERROR'
    return {
      ok: false,
      environment: env,
      steps: { credentialsConfigured: true, tokenAcquired: true, apiReachable: false },
      message: `API:et svarade inte korrekt (${code}).`,
    }
  }

  return {
    ok: true,
    environment: env,
    steps: { credentialsConfigured: true, tokenAcquired: true, apiReachable: true },
    message: 'Bolagsverket OAuth fungerar. API är tillgängligt.',
  }
}

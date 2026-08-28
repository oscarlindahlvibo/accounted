import type { CompanyLookupResult } from './types'
import { normalizeOrgNumber } from './normalize-org-number'

/**
 * Outcome of a client-side company lookup (Bolagsverket, falling back to
 * TIC).
 *
 * - `found`: a provider answered with company data.
 * - `not_found`: a provider looked and the company does not exist. Show the
 *   "hittas inte" path; the user continues manually.
 * - `disabled`: no provider is available at all (neither Bolagsverket nor
 *   TIC configured, or malformed orgnr). Degrade silently to the manual
 *   path; there is nothing the user can do and nothing is wrong with their
 *   input.
 * - `error`: transient failure (429 rate limit, 502/504 upstream, 500,
 *   network) on every provider tried. Show the advisory "kunde inte
 *   hämta" note and continue manually. Never blocks.
 * - `aborted`: the caller's AbortSignal fired; ignore the result.
 */
export type CompanyLookupOutcome =
  | { status: 'found'; result: CompanyLookupResult }
  | { status: 'not_found' }
  | { status: 'disabled' }
  | { status: 'error' }
  | { status: 'aborted' }

async function attempt(url: string, signal?: AbortSignal): Promise<CompanyLookupOutcome> {
  let res: Response
  try {
    res = await fetch(url, { signal })
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { status: 'aborted' }
    return { status: 'error' }
  }
  if (signal?.aborted) return { status: 'aborted' }

  if (res.ok) {
    try {
      const { data } = (await res.json()) as { data: CompanyLookupResult }
      if (!data || typeof data !== 'object') return { status: 'error' }
      return { status: 'found', result: data }
    } catch {
      return { status: 'error' }
    }
  }

  let body: { error?: unknown; code?: unknown } = {}
  try {
    const parsed = (await res.json()) as unknown
    if (parsed && typeof parsed === 'object') body = parsed as { error?: unknown; code?: unknown }
  } catch {
    // Non-JSON error body: fall through to status-only mapping.
  }

  if (res.status === 503 && body.code === 'NOT_CONFIGURED') return { status: 'disabled' }
  if (res.status === 403) return { status: 'disabled' }
  if (res.status === 404) {
    return body.error === 'Company not found' ? { status: 'not_found' } : { status: 'disabled' }
  }
  if (res.status === 503 && body.code === 'EXTENSION_DISABLED') return { status: 'disabled' }
  return { status: 'error' }
}

/**
 * Shared client-side company lookup for the onboarding surfaces (wizard
 * Step 2 and the journey flow), and any future customer/supplier autofill.
 *
 * Provider order: Bolagsverket's official VärdefullaDatamängder API first
 * (free, always attempted — org-number lookup is core, not
 * extension-gated). Falls back to the TIC extension, when the caller
 * passes `ticEnabled: true`, for every Bolagsverket outcome EXCEPT a
 * definitive answer: `found` and `not_found` are terminal (a confirmed
 * "yes" or "no" from the official source is not worth second-guessing
 * against TIC), while `disabled` (unconfigured) and `error` (transient:
 * 429/5xx/network/timeout) both fall through, so a Bolagsverket outage
 * degrades to the previously-sole TIC path instead of failing outright.
 * One HTTP round trip when Bolagsverket answers definitively; two on
 * fallback.
 *
 * TIC budget note: this is the ONLY function that may call the Lens-backed
 * `/lookup` from the client. Callers fire it once per confirmed orgnr
 * (Enter / picker selection), not per keystroke; both servers keep their
 * own process caches as a second guard.
 */
export async function fetchCompanyLookup(
  orgNumber: string,
  opts: { ticEnabled: boolean; signal?: AbortSignal },
): Promise<CompanyLookupOutcome> {
  if (normalizeOrgNumber(orgNumber) === null) return { status: 'disabled' }

  const bolagsverket = await attempt(
    `/api/company-lookup/bolagsverket?org_number=${encodeURIComponent(orgNumber)}`,
    opts.signal,
  )
  const isDefinitive = bolagsverket.status === 'found' || bolagsverket.status === 'not_found'
  if (isDefinitive || bolagsverket.status === 'aborted') return bolagsverket

  if (!opts.ticEnabled) return bolagsverket

  return attempt(`/api/extensions/ext/tic/lookup?org_number=${encodeURIComponent(orgNumber)}`, opts.signal)
}

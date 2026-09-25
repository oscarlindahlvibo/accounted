import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createLogger } from '@/lib/logger'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { lookupCompanyViaBolagsverket } from '@/lib/bolagsverket/organisation'
import { isBolagsverketConfigured } from '@/lib/bolagsverket/env'
import { BolagsverketApiError } from '@/lib/bolagsverket/client'

const ERROR_MESSAGES: Record<string, string> = {
  AUTH_FAILED: 'Kunde inte autentisera mot Bolagsverket.',
  RATE_LIMITED: 'Bolagsverket har tillfälligt begränsat antalet anrop. Försök igen om en stund.',
  TIMEOUT: 'Bolagsverket svarade inte i tid.',
  NETWORK_ERROR: 'Kunde inte nå Bolagsverket.',
  UPSTREAM_ERROR: 'Bolagsverket svarade med ett fel.',
  NOT_FOUND: 'Hittades inte.',
}
function safeMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? 'Ett oväntat fel uppstod.'
}


const log = createLogger('api.company-lookup.bolagsverket')

/**
 * GET /api/company-lookup/bolagsverket?org_number=...
 *
 * Core (not extension-gated) company lookup via Bolagsverket's official
 * VärdefullaDatamängder API — the primary source for
 * lib/company-lookup/fetch-company-lookup.ts, which falls back to the TIC
 * extension only when this is unconfigured or returns nothing.
 *
 * Response contract intentionally mirrors the existing TIC /lookup route
 * (extensions/general/tic/index.ts) so both providers can share one client
 * helper and one CompanyLookupOutcome enum:
 *   200 { data: CompanyLookupResult }
 *   404 { error: 'Company not found' }
 *   503 { code: 'NOT_CONFIGURED' }              -> client treats as disabled
 *   429/5xx                                      -> client treats as transient error
 *
 * No company context required: used before a company exists (onboarding),
 * same as the TIC route's skipCompanyContext.
 */
export async function GET(request: Request) {
  const { user, error } = await requireAuth()
  if (error) return error

  const url = new URL(request.url)
  const orgNumberRaw = url.searchParams.get('org_number')
  if (!orgNumberRaw) {
    return NextResponse.json({ error: 'org_number query parameter is required' }, { status: 400 })
  }
  if (!normalizeOrgNumber(orgNumberRaw)) {
    return NextResponse.json({ error: 'org_number is not a valid Swedish identifier' }, { status: 400 })
  }

  if (!isBolagsverketConfigured()) {
    return NextResponse.json({ code: 'NOT_CONFIGURED' }, { status: 503 })
  }

  try {
    const result = await lookupCompanyViaBolagsverket(orgNumberRaw)
    if (!result) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 })
    }
    return NextResponse.json({ data: result })
  } catch (err) {
    if (err instanceof BolagsverketApiError) {
      log.warn('lookup failed', { userId: user.id, code: err.code })
      const status = err.code === 'RATE_LIMITED' ? 429 : err.code === 'AUTH_FAILED' ? 502 : 502
      return NextResponse.json({ error: safeMessage(err.code), code: err.code }, { status })
    }
    log.error('lookup threw unexpectedly', { userId: user.id, error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

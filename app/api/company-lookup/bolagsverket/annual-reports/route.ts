import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createLogger } from '@/lib/logger'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { getBolagsverketAnnualReports } from '@/lib/bolagsverket/annual-reports'
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


const log = createLogger('api.company-lookup.bolagsverket.annual-reports')

/** GET /api/company-lookup/bolagsverket/annual-reports?org_number=... */
export async function GET(request: Request) {
  const { user, error } = await requireAuth()
  if (error) return error

  const url = new URL(request.url)
  const orgNumberRaw = url.searchParams.get('org_number')
  if (!orgNumberRaw || !normalizeOrgNumber(orgNumberRaw)) {
    return NextResponse.json({ error: 'org_number query parameter is required and must be valid' }, { status: 400 })
  }
  if (!isBolagsverketConfigured()) {
    return NextResponse.json({ code: 'NOT_CONFIGURED' }, { status: 503 })
  }

  try {
    const data = await getBolagsverketAnnualReports(orgNumberRaw)
    return NextResponse.json({ data })
  } catch (err) {
    if (err instanceof BolagsverketApiError) {
      log.warn('annual-reports list failed', { userId: user.id, code: err.code })
      return NextResponse.json({ error: safeMessage(err.code), code: err.code }, { status: err.code === 'RATE_LIMITED' ? 429 : 502 })
    }
    log.error('annual-reports list threw unexpectedly', { userId: user.id, error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

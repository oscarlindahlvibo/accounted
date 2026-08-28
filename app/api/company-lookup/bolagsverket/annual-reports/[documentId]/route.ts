import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { createLogger } from '@/lib/logger'
import { getBolagsverketAnnualReportDocument } from '@/lib/bolagsverket/annual-reports'
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


const log = createLogger('api.company-lookup.bolagsverket.annual-report-document')

/**
 * GET /api/company-lookup/bolagsverket/annual-reports/[documentId]
 *
 * Streams the raw ZIP Bolagsverket serves for a digitally filed annual
 * report. Accounted does not parse the iXBRL/XHTML inside it yet — see
 * docs/integrations/bolagsverket.md.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { user, error } = await requireAuth()
  if (error) return error
  const { documentId } = await params

  if (!documentId) {
    return NextResponse.json({ error: 'documentId is required' }, { status: 400 })
  }
  if (!isBolagsverketConfigured()) {
    return NextResponse.json({ code: 'NOT_CONFIGURED' }, { status: 503 })
  }

  try {
    const { zip, contentType } = await getBolagsverketAnnualReportDocument(documentId)
    return new NextResponse(zip, { headers: { 'Content-Type': contentType } })
  } catch (err) {
    if (err instanceof BolagsverketApiError) {
      log.warn('annual-report document fetch failed', { userId: user.id, code: err.code })
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'RATE_LIMITED' ? 429 : 502
      return NextResponse.json({ error: safeMessage(err.code), code: err.code }, { status })
    }
    log.error('annual-report document fetch threw unexpectedly', {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

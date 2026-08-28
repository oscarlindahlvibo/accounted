import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { bolagsverketRequest, BolagsverketApiError } from './client'
import { annualReportListCache } from './cache'
import type { BvDokumentlistaItem, BvDokumentlistaSvar } from './types'

/**
 * Normalized annual-report list entry. Field names deliberately match what
 * Bolagsverket's `/dokumentlista` operation actually returns
 * (dokumentId, filformat, rapporteringsperiodTom, registreringstidpunkt) —
 * there is no `fiscalYearStart` or `documentType` in this API, so those are
 * not invented here. `rapporteringsperiodTom` is the END of the reporting
 * period only; the API does not expose a period start.
 */
export interface BolagsverketAnnualReport {
  documentId: string
  fileFormat: string
  reportingPeriodEnd: string | null
  registeredAt: string | null
}

/**
 * List available annual reports for a Swedish org number. Returns an empty
 * array (not an error) when the company has none. Cached in-process for
 * BOLAGSVERKET_DOCLIST_CACHE_TTL_MS (default 6h).
 */
export async function getBolagsverketAnnualReports(orgNumber: string): Promise<BolagsverketAnnualReport[]> {
  const cleaned = normalizeOrgNumber(orgNumber)
  if (!cleaned) return []

  const cached = annualReportListCache.get(cleaned) as BolagsverketAnnualReport[] | undefined
  if (cached !== undefined) return cached

  let items: BvDokumentlistaItem[]
  try {
    const response = await bolagsverketRequest<BvDokumentlistaSvar>('/dokumentlista', {
      method: 'POST',
      body: { identitetsbeteckning: cleaned },
    })
    items = (response as BvDokumentlistaSvar).dokument ?? []
  } catch (err) {
    if (err instanceof BolagsverketApiError && err.code === 'NOT_FOUND') {
      items = []
    } else {
      throw err
    }
  }

  const result: BolagsverketAnnualReport[] = items.map((item) => ({
    documentId: item.dokumentId,
    fileFormat: item.filformat,
    reportingPeriodEnd: item.rapporteringsperiodTom ?? null,
    registeredAt: item.registreringstidpunkt ?? null,
  }))

  annualReportListCache.set(cleaned, result)
  return result
}

export interface BolagsverketAnnualReportDocument {
  /** The raw ZIP archive Bolagsverket serves for a digitally filed annual
   * report (content-type application/zip per the verified OpenAPI spec).
   * Accounted does not parse its contents (iXBRL/XHTML inside the archive)
   * yet — see docs/integrations/bolagsverket.md for why that is deliberately
   * out of scope for this pass. */
  zip: ArrayBuffer
  contentType: string
}

/**
 * Fetch one annual report document by its `dokumentId` (from
 * getBolagsverketAnnualReports). Not cached: documents are large and,
 * unlike the list, are typically fetched once per user action rather than
 * on every page load.
 */
export async function getBolagsverketAnnualReportDocument(
  documentId: string,
): Promise<BolagsverketAnnualReportDocument> {
  const response = (await bolagsverketRequest(`/dokument/${encodeURIComponent(documentId)}`, {
    method: 'GET',
    raw: true,
  })) as Response
  const zip = await response.arrayBuffer()
  return { zip, contentType: response.headers.get('content-type') ?? 'application/zip' }
}

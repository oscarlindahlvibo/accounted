import { createLogger } from '@/lib/logger'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'
import { bolagsverketRequest, BolagsverketApiError } from './client'
import { organisationCache } from './cache'
import type { BvOrganisation, BvOrganisationerSvar } from './types'

const log = createLogger('bolagsverket.organisation')

/**
 * Fetch raw organisation data for a Swedish org number ("identitetsbeteckning")
 * from Bolagsverket's VärdefullaDatamängder API. Accepts either
 * "556123-4567" or "5561234567" (normalized before the request; Bolagsverket's
 * own examples use the unformatted 10-digit form). Returns null when the
 * organisation does not exist (ORGANISATION_FINNS_EJ / 404), matching
 * lookupCompanyByOrgNumber's "clean not found" contract.
 *
 * Cached in-process for BOLAGSVERKET_ORG_CACHE_TTL_MS (default 24h): company
 * facts change on Bolagsverket's own filing cadence, measured in days.
 */
export async function getBolagsverketOrganisation(orgNumber: string): Promise<BvOrganisation | null> {
  const cleaned = normalizeOrgNumber(orgNumber)
  if (!cleaned) return null

  const cached = organisationCache.get(cleaned) as BvOrganisation | null | undefined
  if (cached !== undefined) return cached

  let result: BvOrganisation | null
  try {
    const response = await bolagsverketRequest<BvOrganisationerSvar>('/organisationer', {
      method: 'POST',
      body: { identitetsbeteckning: cleaned },
    })
    const organisationer = (response as BvOrganisationerSvar).organisationer ?? []
    result = organisationer[0] ?? null
  } catch (err) {
    if (err instanceof BolagsverketApiError && err.code === 'NOT_FOUND') {
      result = null
    } else {
      throw err
    }
  }

  organisationCache.set(cleaned, result)
  return result
}

/**
 * Pick the organisation's current legal name: the most recently registered
 * entry in organisationsnamnLista. Bolagsverket does not flag one entry as
 * "current" explicitly, so recency by registreringsdatum is the best signal
 * available; entries without a date sort last.
 */
function currentName(org: BvOrganisation): string {
  const list = org.organisationsnamn?.organisationsnamnLista ?? []
  if (list.length === 0) return ''
  const sorted = [...list].sort((a, b) => {
    if (!a.registreringsdatum) return 1
    if (!b.registreringsdatum) return -1
    return b.registreringsdatum.localeCompare(a.registreringsdatum)
  })
  return sorted[0].namn
}

/**
 * Map a raw Bolagsverket organisation to Accounted's provider-agnostic
 * CompanyLookupResult (lib/company-lookup/types.ts), the same shape the TIC
 * provider produces.
 *
 * Fields Bolagsverket's VärdefullaDatamängder does NOT provide (verified
 * against the real OpenAPI schema, not guessed) are left at their honest
 * "unknown" value rather than a fabricated default:
 *   - registration.fTax / registration.vat: not present in this API at all
 *     -> null (see the CompanyLookupResult.registration type: widened to
 *     accept null specifically for this provider).
 *   - bankAccounts, email, phone, fiscalYear: not present -> [] / null / undefined,
 *     which are already valid "provider didn't return this" states for
 *     every existing consumer.
 */
export function mapBolagsverketToCompanyLookupResult(org: BvOrganisation): CompanyLookupResult {
  const address = org.postadressOrganisation?.postadress
  const sni = org.naringsgrenOrganisation?.sni ?? []
  // isCeased relies ONLY on Bolagsverket's own avregistreringsdatum, never
  // on SCB's verksamOrganisation.kod. Confirmed against real production
  // data (802511-1959, an active ideell forening not registered at
  // Bolagsverket at all -- every Bolagsverket-sourced field, including
  // avregistreradOrganisation, errors with ORGANISATION_FINNS_EJ, which is
  // correctly not-ceased): SCB's "aktiv" flag reads NEJ for this real,
  // existing association, so treating it as a ceased-signal produced a
  // false "Avregistrerad" for an organisation that simply isn't the kind
  // Bolagsverket tracks. avregistreringsdatum is the one field that only
  // gets a real value when Bolagsverket has actually recorded a
  // deregistration; anything else is a guess.
  const isCeased = Boolean(org.avregistreradOrganisation?.avregistreringsdatum)

  return {
    companyName: currentName(org),
    isCeased,
    address: address
      ? {
          street: address.utdelningsadress ?? null,
          postalCode: address.postnummer ?? null,
          city: address.postort ?? null,
        }
      : null,
    registration: { fTax: null, vat: null },
    bankAccounts: [],
    email: null,
    phone: null,
    // The API (verified against real acceptance test data) can include
    // blank sni entries alongside real ones; drop anything without an
    // actual code rather than surfacing empty rows in the UI.
    sniCodes: sni
      .filter((s) => s.kod?.trim())
      .map((s) => ({ code: s.kod.trim(), name: (s.klartext ?? '').trim() })),
    fiscalYear: null,
    legalEntityType: org.organisationsform?.kod ?? null,
    registrationDate: org.organisationsdatum?.registreringsdatum
      ? Date.parse(org.organisationsdatum.registreringsdatum) || null
      : null,
  }
}

export async function lookupCompanyViaBolagsverket(orgNumber: string): Promise<CompanyLookupResult | null> {
  const org = await getBolagsverketOrganisation(orgNumber)
  if (!org) return null
  const mapped = mapBolagsverketToCompanyLookupResult(org)
  log.info('lookup resolved', { hasName: Boolean(mapped.companyName) })
  return mapped
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { BvOrganisation } from '../types'

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 })
}

const AKTIEBOLAG: BvOrganisation = {
  organisationsidentitet: { identitetsbeteckning: '5561234567', typ: { kod: 'X', klartext: 'Organisationsnummer' } },
  organisationsnamn: {
    dataproducent: 'Bolagsverket',
    organisationsnamnLista: [
      { namn: 'Gamla Namnet AB', registreringsdatum: '2010-01-01' },
      { namn: 'Cykelbolaget AB', registreringsdatum: '2024-03-15' },
    ],
  },
  organisationsform: { kod: 'AB', klartext: 'Aktiebolag' },
  verksamOrganisation: { kod: 'JA' },
  postadressOrganisation: {
    postadress: { postnummer: '12345', utdelningsadress: 'Jobbstigen 2', postort: 'Grönköping' },
  },
  organisationsdatum: { registreringsdatum: '2010-01-01' },
  naringsgrenOrganisation: { sni: [{ kod: '01120', klartext: 'Odling av ris' }] },
}

describe('mapBolagsverketToCompanyLookupResult', () => {
  it('maps the current (most recently registered) name, address and SNI', async () => {
    const { mapBolagsverketToCompanyLookupResult } = await import('../organisation')
    const result = mapBolagsverketToCompanyLookupResult(AKTIEBOLAG)

    expect(result.companyName).toBe('Cykelbolaget AB')
    expect(result.address).toEqual({ street: 'Jobbstigen 2', postalCode: '12345', city: 'Grönköping' })
    expect(result.sniCodes).toEqual([{ code: '01120', name: 'Odling av ris' }])
    expect(result.legalEntityType).toBe('AB')
    expect(result.isCeased).toBe(false)
  })

  it('never fabricates F-skatt/moms: both are null (not present in this API)', async () => {
    const { mapBolagsverketToCompanyLookupResult } = await import('../organisation')
    const result = mapBolagsverketToCompanyLookupResult(AKTIEBOLAG)
    expect(result.registration).toEqual({ fTax: null, vat: null })
  })

  it('treats a deregistered organisation as ceased', async () => {
    const { mapBolagsverketToCompanyLookupResult } = await import('../organisation')
    const result = mapBolagsverketToCompanyLookupResult({
      ...AKTIEBOLAG,
      avregistreradOrganisation: { avregistreringsdatum: '2023-05-05T00:00:00.000+00:00' },
    })
    expect(result.isCeased).toBe(true)
  })

  it('treats verksamOrganisation.kod === NEJ as ceased even without an avregistrering date', async () => {
    const { mapBolagsverketToCompanyLookupResult } = await import('../organisation')
    const result = mapBolagsverketToCompanyLookupResult({ ...AKTIEBOLAG, verksamOrganisation: { kod: 'NEJ' } })
    expect(result.isCeased).toBe(true)
  })

  it('handles a company with no name list at all', async () => {
    const { mapBolagsverketToCompanyLookupResult } = await import('../organisation')
    const result = mapBolagsverketToCompanyLookupResult({ ...AKTIEBOLAG, organisationsnamn: {} })
    expect(result.companyName).toBe('')
  })
})

describe('getBolagsverketOrganisation', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.stubEnv('BOLAGSVERKET_CLIENT_ID', 'id')
    vi.stubEnv('BOLAGSVERKET_CLIENT_SECRET', 'secret')
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('normalizes 556123-4567 and 5561234567 to the same cache entry (one upstream call)', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ organisationer: [AKTIEBOLAG] }), { status: 200 }))
    const { getBolagsverketOrganisation } = await import('../organisation')

    const a = await getBolagsverketOrganisation('556123-4567')
    const b = await getBolagsverketOrganisation('5561234567')

    expect(a?.organisationsidentitet?.identitetsbeteckning).toBe('5561234567')
    expect(b).toEqual(a)
    // token + one organisationer call; the second lookup is a cache hit.
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('returns null (not an error) for a 404 NOT_FOUND', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ status: 404 }), { status: 404 }))
    const { getBolagsverketOrganisation } = await import('../organisation')
    const result = await getBolagsverketOrganisation('5561234567')
    expect(result).toBeNull()
  })

  it('returns null for a malformed org number without calling the API', async () => {
    const { getBolagsverketOrganisation } = await import('../organisation')
    const result = await getBolagsverketOrganisation('not-a-number')
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

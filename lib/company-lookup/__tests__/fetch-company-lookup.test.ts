import { describe, it, expect, beforeEach, vi } from 'vitest'
import { fetchCompanyLookup } from '../fetch-company-lookup'
import type { CompanyLookupResult } from '../types'

const LOOKUP: CompanyLookupResult = {
  companyName: 'Nordvik Bygg & Konsult AB',
  isCeased: false,
  address: { street: 'Storgatan 1', postalCode: '211 34', city: 'Malmö' },
  registration: { fTax: true, vat: true },
  bankAccounts: [],
  email: null,
  phone: null,
  sniCodes: [],
  fiscalYear: { startMonthDay: '01-01', endMonthDay: '12-31' },
  legalEntityType: 'AB',
  registrationDate: 1710000000000,
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const BOLAGSVERKET_URL = '/api/company-lookup/bolagsverket?org_number=';
const TIC_URL = '/api/extensions/ext/tic/lookup?org_number=';

describe('fetchCompanyLookup', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  it('returns disabled without fetching for a malformed orgnr', async () => {
    const outcome = await fetchCompanyLookup('12', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'disabled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a Bolagsverket result on 200 without ever calling TIC', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: LOOKUP }))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'found', result: LOOKUP })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(BOLAGSVERKET_URL)
  })

  it("maps Bolagsverket's 404 (Company not found) to not_found without trying TIC", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Company not found' }))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'not_found' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to TIC when Bolagsverket is unconfigured (503 NOT_CONFIGURED)', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/company-lookup/bolagsverket')
        ? jsonResponse(503, { code: 'NOT_CONFIGURED' })
        : jsonResponse(200, { data: LOOKUP }),
    )
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'found', result: LOOKUP })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toContain(TIC_URL)
  })

  it('falls back to TIC when Bolagsverket errors transiently (429/5xx/network)', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/company-lookup/bolagsverket')
        ? jsonResponse(429, { error: 'Rate limit exceeded' })
        : jsonResponse(200, { data: LOOKUP }),
    )
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'found', result: LOOKUP })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not try TIC when ticEnabled is false, even if Bolagsverket is unconfigured', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { code: 'NOT_CONFIGURED' }))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: false })
    expect(outcome).toEqual({ status: 'disabled' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces error (not disabled) when neither provider is enabled and Bolagsverket fails transiently', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { error: 'boom' }))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: false })
    expect(outcome).toEqual({ status: 'error' })
  })

  it("maps the TIC dispatcher's 404 (Extension not found) to disabled on fallback", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/company-lookup/bolagsverket')
        ? jsonResponse(503, { code: 'NOT_CONFIGURED' })
        : jsonResponse(404, { error: 'Extension not found' }),
    )
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'disabled' })
  })

  it('maps a network failure on Bolagsverket, then a TIC success, to found', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.includes('/company-lookup/bolagsverket')
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(jsonResponse(200, { data: LOOKUP })),
    )
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'found', result: LOOKUP })
  })

  it('maps an abort on the first (Bolagsverket) call to aborted without trying TIC', async () => {
    const abortError = new DOMException('Aborted', 'AbortError')
    fetchMock.mockRejectedValue(abortError)
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: true })
    expect(outcome).toEqual({ status: 'aborted' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps a malformed success body to error', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    const outcome = await fetchCompanyLookup('556677-8899', { ticEnabled: false })
    expect(outcome).toEqual({ status: 'error' })
  })
})

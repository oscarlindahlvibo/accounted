import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 })
}

describe('getBolagsverketAnnualReports', () => {
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

  it('maps dokumentlista fields using their real API names', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          dokument: [
            { dokumentId: 'doc-1', filformat: 'ixbrl', rapporteringsperiodTom: '2025-12-31', registreringstidpunkt: '2026-03-01' },
          ],
        }),
        { status: 200 },
      ),
    )
    const { getBolagsverketAnnualReports } = await import('../annual-reports')
    const result = await getBolagsverketAnnualReports('5561234567')
    expect(result).toEqual([
      { documentId: 'doc-1', fileFormat: 'ixbrl', reportingPeriodEnd: '2025-12-31', registeredAt: '2026-03-01' },
    ])
  })

  it('returns an empty array (not an error) when there are no reports', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ dokument: [] }), { status: 200 }))
    const { getBolagsverketAnnualReports } = await import('../annual-reports')
    expect(await getBolagsverketAnnualReports('5561234567')).toEqual([])
  })

  it('caches the list per normalized org number', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ dokument: [] }), { status: 200 }))
    const { getBolagsverketAnnualReports } = await import('../annual-reports')
    await getBolagsverketAnnualReports('556123-4567')
    await getBolagsverketAnnualReports('5561234567')
    expect(fetchSpy).toHaveBeenCalledTimes(2) // token + one list call
  })
})

describe('getBolagsverketAnnualReportDocument', () => {
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

  it('returns the raw zip bytes and content type', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    fetchSpy.mockResolvedValueOnce(
      new Response(zipBytes, { status: 200, headers: { 'Content-Type': 'application/zip' } }),
    )
    const { getBolagsverketAnnualReportDocument } = await import('../annual-reports')
    const { zip, contentType } = await getBolagsverketAnnualReportDocument('doc-1')
    expect(contentType).toBe('application/zip')
    expect(new Uint8Array(zip)).toEqual(zipBytes)
  })

  it('propagates NOT_FOUND for an unknown document id', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ status: 404 }), { status: 404 }))
    const { getBolagsverketAnnualReportDocument } = await import('../annual-reports')
    await expect(getBolagsverketAnnualReportDocument('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

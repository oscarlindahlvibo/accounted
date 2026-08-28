import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 })
}

describe('bolagsverket client', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    vi.stubEnv('BOLAGSVERKET_CLIENT_ID', 'id')
    vi.stubEnv('BOLAGSVERKET_CLIENT_SECRET', 'super-secret-value')
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('throws NOT_CONFIGURED when credentials are absent, before touching the network', async () => {
    vi.unstubAllEnvs()
    vi.resetModules()
    const { bolagsverketRequest } = await import('../client')
    await expect(bolagsverketRequest('/organisationer')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('attaches Authorization header and returns parsed JSON on success', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ organisationer: [] }), { status: 200 }))
    const { bolagsverketRequest } = await import('../client')

    const result = await bolagsverketRequest('/organisationer', { method: 'POST', body: { identitetsbeteckning: '5561234567' } })
    expect(result).toEqual({ organisationer: [] })

    const apiCall = fetchSpy.mock.calls[1] as [string, RequestInit]
    const headers = apiCall[1].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok-1')
    expect(headers['X-Request-Id']).toBeTruthy()
  })

  it('maps 404 to NOT_FOUND', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ status: 404 }), { status: 404 }))
    const { bolagsverketRequest } = await import('../client')
    await expect(bolagsverketRequest('/organisationer', { method: 'POST' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('retries once on 429 then succeeds', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 429 }))
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ organisationer: [] }), { status: 200 }))
    const { bolagsverketRequest } = await import('../client')
    const result = await bolagsverketRequest('/organisationer', { method: 'POST' })
    expect(result).toEqual({ organisationer: [] })
  }, 10_000)

  it('gives up after exhausting retries on repeated 429', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 429 }))
    const { bolagsverketRequest } = await import('../client')
    await expect(bolagsverketRequest('/organisationer', { method: 'POST' })).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  }, 10_000)

  it('retries on 5xx', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 503 }))
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ organisationer: [] }), { status: 200 }))
    const { bolagsverketRequest } = await import('../client')
    const result = await bolagsverketRequest('/organisationer', { method: 'POST' })
    expect(result).toEqual({ organisationer: [] })
  }, 10_000)

  it('retries once on 401 after invalidating the token cache', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({}), { status: 401 }))
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ organisationer: [] }), { status: 200 }))
    const { bolagsverketRequest } = await import('../client')
    const result = await bolagsverketRequest('/organisationer', { method: 'POST' })
    expect(result).toEqual({ organisationer: [] })
    expect(fetchSpy).toHaveBeenCalledTimes(4) // token, 401, token, success
  })

  it('maps a network error to NETWORK_ERROR after retries', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'))
    const { bolagsverketRequest } = await import('../client')
    await expect(bolagsverketRequest('/organisationer', { method: 'POST' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  }, 10_000)

  it('maps an abort/timeout error to TIMEOUT', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    const { bolagsverketRequest } = await import('../client')
    await expect(bolagsverketRequest('/organisationer', { method: 'POST' })).rejects.toMatchObject({ code: 'TIMEOUT' })
  }, 10_000)

  it('never includes the client secret in a thrown error message', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }))
    const { bolagsverketRequest } = await import('../client')
    try {
      await bolagsverketRequest('/organisationer', { method: 'POST' })
      expect.unreachable()
    } catch (err) {
      expect(String(err instanceof Error ? err.message : err)).not.toContain('super-secret-value')
    }
  })
})

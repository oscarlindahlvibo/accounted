import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: 'super-secret-token-value', expires_in: 3600 }), { status: 200 })
}

describe('testBolagsverketConnection', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it('reports credentialsConfigured: false with no env vars, without calling the network', async () => {
    const { testBolagsverketConnection } = await import('../test-connection')
    const result = await testBolagsverketConnection()
    expect(result.ok).toBe(false)
    expect(result.steps.credentialsConfigured).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports tokenAcquired: false when the token endpoint rejects credentials', async () => {
    vi.stubEnv('BOLAGSVERKET_CLIENT_ID', 'id')
    vi.stubEnv('BOLAGSVERKET_CLIENT_SECRET', 'wrong-secret')
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }))
    const { testBolagsverketConnection } = await import('../test-connection')
    const result = await testBolagsverketConnection()
    expect(result.ok).toBe(false)
    expect(result.steps.credentialsConfigured).toBe(true)
    expect(result.steps.tokenAcquired).toBe(false)
  })

  it('reports ok: true when isalive answers', async () => {
    vi.stubEnv('BOLAGSVERKET_CLIENT_ID', 'id')
    vi.stubEnv('BOLAGSVERKET_CLIENT_SECRET', 'super-secret-value')
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response('OK', { status: 200 }))
    const { testBolagsverketConnection } = await import('../test-connection')
    const result = await testBolagsverketConnection()
    expect(result.ok).toBe(true)
    expect(result.steps).toEqual({ credentialsConfigured: true, tokenAcquired: true, apiReachable: true })
  })

  it('never includes the access token or client secret anywhere in the result', async () => {
    vi.stubEnv('BOLAGSVERKET_CLIENT_ID', 'id')
    vi.stubEnv('BOLAGSVERKET_CLIENT_SECRET', 'super-secret-value')
    fetchSpy.mockResolvedValueOnce(tokenResponse())
    fetchSpy.mockResolvedValueOnce(new Response('OK', { status: 200 }))
    const { testBolagsverketConnection } = await import('../test-connection')
    const result = await testBolagsverketConnection()
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('super-secret-token-value')
    expect(serialized).not.toContain('super-secret-value')
  })
})

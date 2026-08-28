import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('bolagsverket token', () => {
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

  function tokenResponse(expiresIn = 3600) {
    return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: expiresIn }), { status: 200 })
  }

  it('mints a token and caches it (single fetch across repeated calls)', async () => {
    fetchSpy.mockResolvedValue(tokenResponse())
    const { getBolagsverketAccessToken } = await import('../token')

    const a = await getBolagsverketAccessToken()
    const b = await getBolagsverketAccessToken()

    expect(a).toBe('tok-1')
    expect(b).toBe('tok-1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('never sends client_secret in a header, only in the form body', async () => {
    fetchSpy.mockResolvedValue(tokenResponse())
    const { getBolagsverketAccessToken } = await import('../token')
    await getBolagsverketAccessToken()

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const headerValues = Object.values((init.headers as Record<string, string>) ?? {}).join(' ')
    expect(headerValues).not.toContain('secret')
    expect(String(init.body)).toContain('client_secret=secret')
  })

  it('re-mints once the cached token is within the refresh margin of expiry', async () => {
    fetchSpy.mockResolvedValueOnce(tokenResponse(30)) // expires in 30s, margin is 60s
    fetchSpy.mockResolvedValueOnce(tokenResponse(3600))
    const { getBolagsverketAccessToken } = await import('../token')

    await getBolagsverketAccessToken()
    await getBolagsverketAccessToken()

    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent callers into a single mint', async () => {
    let resolveFetch!: (r: Response) => void
    fetchSpy.mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)))
    const { getBolagsverketAccessToken } = await import('../token')

    const p1 = getBolagsverketAccessToken()
    const p2 = getBolagsverketAccessToken()
    resolveFetch(tokenResponse())

    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBe('tok-1')
    expect(b).toBe('tok-1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('throws BolagsverketAuthError on 401/403 without leaking response details as a token', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }))
    const { getBolagsverketAccessToken, BolagsverketAuthError } = await import('../token')
    await expect(getBolagsverketAccessToken()).rejects.toBeInstanceOf(BolagsverketAuthError)
  })

  it('throws BolagsverketAuthError on network timeout', async () => {
    fetchSpy.mockImplementation(
      () =>
        new Promise((_, reject) => {
          const err = new DOMException('Aborted', 'AbortError')
          reject(err)
        }),
    )
    const { getBolagsverketAccessToken, BolagsverketAuthError } = await import('../token')
    await expect(getBolagsverketAccessToken()).rejects.toBeInstanceOf(BolagsverketAuthError)
  })

  it('throws when the token endpoint returns no access_token', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    const { getBolagsverketAccessToken, BolagsverketAuthError } = await import('../token')
    await expect(getBolagsverketAccessToken()).rejects.toBeInstanceOf(BolagsverketAuthError)
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'

describe('bolagsverket env', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('isBolagsverketConfigured is false with no credentials', async () => {
    const { isBolagsverketConfigured } = await import('../env')
    expect(isBolagsverketConfigured()).toBe(false)
  })

  it('isBolagsverketConfigured is true once both credentials are set', async () => {
    vi.stubEnv('BOLAGSVERKET_CLIENT_ID', 'id')
    vi.stubEnv('BOLAGSVERKET_CLIENT_SECRET', 'secret')
    const { isBolagsverketConfigured } = await import('../env')
    expect(isBolagsverketConfigured()).toBe(true)
  })

  it('resolves acceptance defaults without needing explicit URLs', async () => {
    vi.stubEnv('BOLAGSVERKET_CLIENT_ID', 'id')
    vi.stubEnv('BOLAGSVERKET_CLIENT_SECRET', 'secret')
    const { getBolagsverketConfig } = await import('../env')
    const config = getBolagsverketConfig()
    expect(config.env).toBe('acceptance')
    expect(config.apiBaseUrl).toBe('https://gw-accept2.api.bolagsverket.se/vardefulla-datamangder/v1')
    expect(config.tokenUrl).toBe('https://portal-accept2.api.bolagsverket.se/oauth2/token')
  })

  it('throws a clear config error for production without explicit URLs (never guesses)', async () => {
    vi.stubEnv('BOLAGSVERKET_CLIENT_ID', 'id')
    vi.stubEnv('BOLAGSVERKET_CLIENT_SECRET', 'secret')
    vi.stubEnv('BOLAGSVERKET_ENV', 'production')
    const { getBolagsverketConfig, BolagsverketConfigError } = await import('../env')
    expect(() => getBolagsverketConfig()).toThrow(BolagsverketConfigError)
    expect(() => getBolagsverketConfig()).toThrow(/BOLAGSVERKET_API_BASE_URL/)
  })

  it('accepts explicit production URLs when provided', async () => {
    vi.stubEnv('BOLAGSVERKET_CLIENT_ID', 'id')
    vi.stubEnv('BOLAGSVERKET_CLIENT_SECRET', 'secret')
    vi.stubEnv('BOLAGSVERKET_ENV', 'production')
    vi.stubEnv('BOLAGSVERKET_API_BASE_URL', 'https://gw.example/vardefulla-datamangder/v1')
    vi.stubEnv('BOLAGSVERKET_TOKEN_URL', 'https://gw.example/oauth2/token')
    const { getBolagsverketConfig } = await import('../env')
    const config = getBolagsverketConfig()
    expect(config.env).toBe('production')
    expect(config.apiBaseUrl).toBe('https://gw.example/vardefulla-datamangder/v1')
  })

  it('throws when credentials are missing entirely', async () => {
    const { getBolagsverketConfig, BolagsverketConfigError } = await import('../env')
    expect(() => getBolagsverketConfig()).toThrow(BolagsverketConfigError)
  })
})

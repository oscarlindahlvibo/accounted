/**
 * In-process TTL cache, same pattern as extensions/general/tic/lib/tic-client.ts
 * (this codebase has no shared Redis/cache infra — see docs/integrations/bolagsverket.md).
 * Company data changes rarely, so a modest process-local cache meaningfully
 * cuts calls against Bolagsverket's rate limit without adding new infra.
 */

interface CacheEntry<T> {
  expiresAt: number
  value: T
}

export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>()
  constructor(
    private ttlMs: number,
    private maxEntries = 500,
  ) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      const drop = Math.max(1, Math.floor(this.maxEntries / 10))
      const keys = Array.from(this.store.keys()).slice(0, drop)
      for (const k of keys) this.store.delete(k)
    }
    this.store.set(key, { expiresAt: Date.now() + this.ttlMs, value })
  }

  clear(): void {
    this.store.clear()
  }
}

function envMs(name: string, defaultMs: number): number {
  const raw = process.env[name]
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs
}

/** Organisation lookups: company data changes rarely (filing cycles measured in days). */
export const organisationCache = new TtlCache<unknown>(
  envMs('BOLAGSVERKET_ORG_CACHE_TTL_MS', 24 * 60 * 60 * 1000),
)

/** Annual report document lists: new filings appear at most a few times a year. */
export const annualReportListCache = new TtlCache<unknown>(
  envMs('BOLAGSVERKET_DOCLIST_CACHE_TTL_MS', 6 * 60 * 60 * 1000),
)

import { describe, it, expect, vi, afterEach } from 'vitest'
import { TtlCache } from '../cache'

describe('TtlCache', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns undefined for a missing key', () => {
    const cache = new TtlCache<string>(1000)
    expect(cache.get('x')).toBeUndefined()
  })

  it('returns a set value before expiry', () => {
    const cache = new TtlCache<string>(1000)
    cache.set('x', 'value')
    expect(cache.get('x')).toBe('value')
  })

  it('expires an entry after its TTL', () => {
    vi.useFakeTimers()
    const cache = new TtlCache<string>(1000)
    cache.set('x', 'value')
    vi.advanceTimersByTime(1001)
    expect(cache.get('x')).toBeUndefined()
  })

  it('evicts the oldest ~10% once maxEntries is reached', () => {
    const cache = new TtlCache<number>(60_000, 10)
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, i)
    cache.set('k10', 10)
    // At least the very first key should have been evicted to make room.
    expect(cache.get('k0')).toBeUndefined()
    expect(cache.get('k10')).toBe(10)
  })

  it('clear() empties the cache', () => {
    const cache = new TtlCache<string>(60_000)
    cache.set('x', 'value')
    cache.clear()
    expect(cache.get('x')).toBeUndefined()
  })
})

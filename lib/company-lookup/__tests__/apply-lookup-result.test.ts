import { describe, it, expect } from 'vitest'
import { applyLookupResult } from '../apply-lookup-result'
import type { CompanyLookupResult } from '../types'

const RESULT: CompanyLookupResult = {
  companyName: 'Cykelbolaget AB',
  isCeased: false,
  address: { street: 'Testgatan 1', postalCode: '851 81', city: 'Sundsvall' },
  registration: { fTax: null, vat: null },
  bankAccounts: [],
  email: null,
  phone: null,
  sniCodes: [],
  legalEntityType: 'AB',
  registrationDate: null,
}

describe('applyLookupResult (customer lookup success)', () => {
  it('fills every empty field from a fresh (all-empty) form', () => {
    const { fields, skipped } = applyLookupResult(RESULT, {})
    expect(fields).toEqual({
      name: 'Cykelbolaget AB',
      address_line1: 'Testgatan 1',
      postal_code: '851 81',
      city: 'Sundsvall',
    })
    expect(skipped).toEqual([])
  })
})

describe('applyLookupResult (supplier lookup success)', () => {
  it('fills fields the same way regardless of which form calls it', () => {
    const { fields } = applyLookupResult(RESULT, { name: '', address_line1: '', postal_code: '', city: '' })
    expect(fields.name).toBe('Cykelbolaget AB')
    expect(fields.city).toBe('Sundsvall')
  })
})

describe('applyLookupResult: already-filled fields', () => {
  it('never overwrites a field the user already typed something into', () => {
    const { fields, skipped } = applyLookupResult(RESULT, {
      name: 'Mitt eget namn AB',
      city: 'Göteborg',
    })
    expect(fields).toEqual({ address_line1: 'Testgatan 1', postal_code: '851 81' })
    expect(skipped.sort()).toEqual(['city', 'name'])
  })

  it('treats a whitespace-only existing value as effectively empty (fills it)', () => {
    const { fields, skipped } = applyLookupResult(RESULT, { name: '   ' })
    expect(fields.name).toBe('Cykelbolaget AB')
    expect(skipped).not.toContain('name')
  })

  it('does not report a field as skipped when the lookup had nothing to offer for it anyway', () => {
    const noAddress: CompanyLookupResult = { ...RESULT, address: null }
    const { fields, skipped } = applyLookupResult(noAddress, { address_line1: 'Redan ifyllt' })
    expect(fields.address_line1).toBeUndefined()
    expect(skipped).toEqual([])
  })
})

describe('applyLookupResult: partial API data', () => {
  it('only fills the fields that are actually present in the result', () => {
    const partial: CompanyLookupResult = { ...RESULT, companyName: '', address: null }
    const { fields } = applyLookupResult(partial, {})
    expect(fields).toEqual({})
  })
})

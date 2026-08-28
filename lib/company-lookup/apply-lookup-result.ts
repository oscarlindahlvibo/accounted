import type { CompanyLookupResult } from './types'

/**
 * Shared "which fields should a company lookup fill in" logic for the
 * customer and supplier forms (and anywhere else this grows to). Used
 * instead of duplicating the same guard in each form.
 *
 * Only fills fields the user hasn't already typed something into — never
 * silently overwrites. Fields the lookup has no answer for (blank/null)
 * are left alone regardless of current value. Returns which of the
 * candidate fields were skipped because the user already had a value, so
 * the caller can surface a one-line "some fields were left as-is" note.
 */
export interface LookupApplicableFields {
  name?: string
  address_line1?: string
  postal_code?: string
  city?: string
}

export interface ApplyLookupResultOutcome {
  /** Only the fields that should actually be written; feed each into setValue. */
  fields: LookupApplicableFields
  /** Field keys the lookup had data for, but were left alone because the user had already filled them in. */
  skipped: Array<keyof LookupApplicableFields>
}

export function applyLookupResult(
  result: CompanyLookupResult,
  current: LookupApplicableFields,
): ApplyLookupResultOutcome {
  const fields: LookupApplicableFields = {}
  const skipped: Array<keyof LookupApplicableFields> = []

  const maybeApply = (key: keyof LookupApplicableFields, value: string | null | undefined) => {
    if (!value) return
    const existing = current[key]
    if (existing && existing.trim()) {
      skipped.push(key)
      return
    }
    fields[key] = value
  }

  maybeApply('name', result.companyName)
  maybeApply('address_line1', result.address?.street)
  maybeApply('postal_code', result.address?.postalCode)
  maybeApply('city', result.address?.city)

  return { fields, skipped }
}

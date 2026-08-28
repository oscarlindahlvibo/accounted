'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, CheckCircle, XCircle, Building2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { fetchCompanyLookup } from '@/lib/company-lookup/fetch-company-lookup'
import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { CompanyLookupResult } from '@/lib/company-lookup/types'

export type CompanyLookupState = 'idle' | 'loading' | 'found' | 'not_found' | 'error'

/**
 * "Hämta företagsuppgifter" button for a Swedish org-number field, shared by
 * the customer and supplier forms.
 *
 * Reuses fetchCompanyLookup() as-is (Bolagsverket first, TIC fallback) --
 * no separate API client. The frontend only ever calls Accounted's own
 * /api/company-lookup/* routes here; it never sees a Bolagsverket/TIC
 * credential or token.
 *
 * Field mapping and the "don't overwrite what the user already typed" rule
 * live in the caller (via onApply + lib/company-lookup/apply-lookup-result.ts),
 * not here: this component only knows how to fetch and report status.
 */
export function CompanyLookupTrigger({
  orgNumber,
  onApply,
  disabled,
}: {
  orgNumber: string
  onApply: (result: CompanyLookupResult) => void
  disabled?: boolean
}) {
  const t = useTranslations('company_lookup')
  const { toast } = useToast()
  const [state, setState] = useState<CompanyLookupState>('idle')

  const isValidOrgNumber = normalizeOrgNumber(orgNumber) !== null

  async function handleClick() {
    if (!isValidOrgNumber || state === 'loading') return
    setState('loading')
    const outcome = await fetchCompanyLookup(orgNumber, { ticEnabled: ENABLED_EXTENSION_IDS.has('tic') })

    if (outcome.status === 'found') {
      setState('found')
      onApply(outcome.result)
      return
    }
    if (outcome.status === 'not_found') {
      setState('not_found')
      toast({ title: t('not_found_title'), description: t('not_found_description') })
      return
    }
    if (outcome.status === 'disabled' || outcome.status === 'aborted') {
      // Nothing configured, or the caller navigated away: not an error the
      // user needs to see, same contract fetchCompanyLookup already defines.
      setState('idle')
      return
    }
    setState('error')
    toast({
      title: t('error_title'),
      description: t('error_description'),
      variant: 'destructive',
    })
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleClick}
        disabled={disabled || !isValidOrgNumber || state === 'loading'}
      >
        {state === 'loading' ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : state === 'found' ? (
          <CheckCircle className="h-4 w-4 text-success" />
        ) : state === 'not_found' || state === 'error' ? (
          <XCircle className="h-4 w-4 text-destructive" />
        ) : (
          <Building2 className="h-4 w-4" />
        )}
        {t('fetch_button')}
      </Button>
      {state === 'found' && (
        <span className="text-xs text-muted-foreground">{t('found_note')}</span>
      )}
    </div>
  )
}

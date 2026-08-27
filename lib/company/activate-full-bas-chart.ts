import type { SupabaseClient } from '@supabase/supabase-js'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Activate the full BAS Kontoplan 2026 (~1290 accounts) for a company,
 * inserting whatever `seed_chart_of_accounts` didn't (it only seeds a
 * curated ~35-account K1 starter set; see 20260731090000_fix_seed_chart_account_names.sql).
 *
 * Vibo: without this, most imports (SIE files, bank categorization) hit
 * accounts that exist in BAS but not yet in the company's own chart, which
 * reads as "can't match this account" even though the number is valid.
 * account-sync.ts already auto-creates missing accounts one at a time during
 * SIE import; this does the same insert up front for every BAS account so
 * nothing is ever missing in the first place.
 *
 * Non-fatal by design: called after chart-of-accounts seeding during
 * company creation, but a failure here must not roll back company creation
 * (the curated K1 set from seed_chart_of_accounts is already sufficient to
 * operate). Errors are returned, not thrown, so the caller can log and
 * continue.
 */
export async function activateFullBasChart(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ inserted: number; error: string | null }> {
  // Same lookup seed_chart_of_accounts itself does (see
  // 20260731090000_fix_seed_chart_account_names.sql): the owner is who
  // chart_of_accounts rows are attributed to, not necessarily the caller.
  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('created_by')
    .eq('id', companyId)
    .maybeSingle()
  if (companyError) return { inserted: 0, error: companyError.message }
  const userId = (company as { created_by: string | null } | null)?.created_by
  if (!userId) return { inserted: 0, error: 'company has no created_by' }

  const existing = await fetchAllRows<{ account_number: string }>(({ from, to }) =>
    supabase
      .from('chart_of_accounts')
      .select('account_number')
      .eq('company_id', companyId)
      .order('account_number', { ascending: true })
      .range(from, to),
  )

  const existingNumbers = new Set(existing.map((a) => a.account_number))
  const missing = BAS_REFERENCE.filter((ref) => !existingNumbers.has(ref.account_number))
  if (missing.length === 0) return { inserted: 0, error: null }

  const rows = missing.map((ref) => ({
    user_id: userId,
    company_id: companyId,
    account_number: ref.account_number,
    account_name: ref.account_name,
    account_class: ref.account_class,
    account_group: ref.account_group,
    account_type: ref.account_type,
    normal_balance: ref.normal_balance,
    plan_type: 'full_bas' as const,
    is_active: true,
    is_system_account: false,
    description: ref.description,
    sru_code: ref.sru_code,
    sort_order: parseInt(ref.account_number, 10),
  }))

  const BATCH_SIZE = 250
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase.from('chart_of_accounts').insert(batch)
    if (error && !error.message.includes('duplicate')) {
      return { inserted: i, error: error.message }
    }
  }

  return { inserted: rows.length, error: null }
}

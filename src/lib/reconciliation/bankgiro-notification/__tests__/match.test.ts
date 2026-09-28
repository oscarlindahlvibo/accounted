import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { matchNotificationEntries } from '../match'
import type { ParsedCamt054Entry } from '../parse-camt054'

/**
 * Chainable Supabase stub serving one queued page per `.from()` call, in
 * call order. Same shape as the shared pattern used in
 * duplicate-payment-candidates.test.ts, trimmed to just page-serving (this
 * module's tests don't need to inspect which filters were applied).
 */
function createQueuedSupabase(pages: Array<Array<Record<string, unknown>>>) {
  let index = 0
  const build = () => {
    const result = { data: pages[index] ?? [], error: null }
    index += 1
    const chain: unknown = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(result)
          return () => chain
        },
      },
    )
    return chain
  }
  return { from: () => build() } as unknown as SupabaseClient
}

const dbitEntry = (subPayments: ParsedCamt054Entry['subPayments']): ParsedCamt054Entry => ({
  direction: 'DBIT',
  amount: subPayments.reduce((s, sp) => s + sp.amount, 0),
  bookingDate: '2026-06-30',
  acctSvcrRef: '2026063082869261',
  subPayments,
})

const txRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'tx-1',
  date: '2026-06-30',
  amount: -3324,
  ...over,
})

describe('matchNotificationEntries', () => {
  it('matches both sub-payments of a two-item lump and reports fullyExplained', async () => {
    const entry = dbitEntry([
      { amount: 2493, counterpartyName: 'DBE Kabel-TV AB', reference: '2114', subAcctSvcrRef: 'a' },
      { amount: 831, counterpartyName: 'DBE Kabel-TV AB', reference: '2141', subAcctSvcrRef: 'b' },
    ])
    // Order: fetchOpenSupplierInvoices, fetchOpenCustomerInvoices (parallel,
    // supplier first), then one transactions query per entry.
    const supabase = createQueuedSupabase([
      [
        { id: 'si-1', supplier_invoice_number: '2114', payment_reference: null, remaining_amount: 2493, payment_journal_entry_id: 'je-1', supplier: { name: 'DBE Kabel-TV AB' } },
        { id: 'si-2', supplier_invoice_number: '2141', payment_reference: null, remaining_amount: 831, payment_journal_entry_id: null, supplier: { name: 'DBE Kabel-TV AB' } },
      ],
      [],
      [txRow()],
    ])

    const [proposal] = await matchNotificationEntries(supabase, 'company-1', [entry])

    expect(proposal.transactionMatchStatus).toBe('matched')
    expect(proposal.transaction).toMatchObject({ id: 'tx-1' })
    expect(proposal.subPayments).toHaveLength(2)
    expect(proposal.subPayments[0].status).toBe('matched')
    expect(proposal.subPayments[0].invoice).toMatchObject({ id: 'si-1', existingJournalEntryId: 'je-1' })
    expect(proposal.subPayments[1].status).toBe('matched')
    expect(proposal.subPayments[1].invoice).toMatchObject({ id: 'si-2', existingJournalEntryId: null })
    expect(proposal.fullyExplained).toBe(true)
  })

  it('flags a sub-payment as ambiguous when two open invoices share the reference and amount', async () => {
    const entry = dbitEntry([
      { amount: 500, counterpartyName: null, reference: '2114', subAcctSvcrRef: 'a' },
    ])
    const supabase = createQueuedSupabase([
      [
        { id: 'si-1', supplier_invoice_number: '2114', payment_reference: null, remaining_amount: 500, payment_journal_entry_id: null, supplier: { name: null } },
        { id: 'si-2', supplier_invoice_number: '2114', payment_reference: null, remaining_amount: 500, payment_journal_entry_id: null, supplier: { name: null } },
      ],
      [],
      [],
    ])

    const [proposal] = await matchNotificationEntries(supabase, 'company-1', [entry])

    expect(proposal.subPayments[0].status).toBe('ambiguous')
    expect(proposal.subPayments[0].candidates).toHaveLength(2)
    expect(proposal.fullyExplained).toBe(false)
  })

  it('flags a sub-payment as unmatched when no open invoice carries the reference', async () => {
    const entry = dbitEntry([
      { amount: 500, counterpartyName: 'Unknown AB', reference: '999999', subAcctSvcrRef: 'a' },
    ])
    const supabase = createQueuedSupabase([[], [], []])

    const [proposal] = await matchNotificationEntries(supabase, 'company-1', [entry])

    expect(proposal.subPayments[0].status).toBe('unmatched')
    expect(proposal.fullyExplained).toBe(false)
  })

  it('reports not_found when no unmatched bank transaction fits the entry amount/date', async () => {
    const entry = dbitEntry([
      { amount: 2093, counterpartyName: 'BYGGVAB Virserum AB', reference: '33174', subAcctSvcrRef: 'a' },
    ])
    const supabase = createQueuedSupabase([
      [{ id: 'si-1', supplier_invoice_number: '33174', payment_reference: null, remaining_amount: 2093, payment_journal_entry_id: null, supplier: { name: 'BYGGVAB Virserum AB' } }],
      [],
      [], // no candidate transactions
    ])

    const [proposal] = await matchNotificationEntries(supabase, 'company-1', [entry])

    expect(proposal.transactionMatchStatus).toBe('not_found')
    expect(proposal.subPayments[0].status).toBe('matched')
    expect(proposal.fullyExplained).toBe(false)
  })

  it('routes a CRDT entry against customer invoices instead of supplier invoices', async () => {
    const entry: ParsedCamt054Entry = {
      direction: 'CRDT',
      amount: 1000,
      bookingDate: '2026-06-30',
      acctSvcrRef: 'ref-crdt',
      subPayments: [{ amount: 1000, counterpartyName: 'Kund AB', reference: '20260099', subAcctSvcrRef: 'a' }],
    }
    const supabase = createQueuedSupabase([
      [], // supplier_invoices (unused for CRDT)
      [{ id: 'inv-1', invoice_number: '20260099', remaining_amount: 1000, journal_entry_id: null, customer: { name: 'Kund AB' } }],
      [txRow({ amount: 1000 })],
    ])

    const [proposal] = await matchNotificationEntries(supabase, 'company-1', [entry])

    expect(proposal.subPayments[0].status).toBe('matched')
    expect(proposal.subPayments[0].invoice).toMatchObject({ type: 'invoice', id: 'inv-1' })
  })
})

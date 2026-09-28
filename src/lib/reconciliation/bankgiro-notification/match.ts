/**
 * Matches a parsed camt.054 Återredovisning against open invoices and the
 * already-synced bank transaction it explains.
 *
 * Reuses the same reference/name primitives the duplicate-payment guard uses
 * (src/lib/invoices/duplicate-payment-guard.ts, ocr-keys.ts) so "what counts
 * as a match" cannot drift between the two features. This module answers the
 * REVERSE question they do, though: given a reference + counterparty name
 * (from the file), which open invoice does it belong to — not, given an
 * invoice, which bank rows might be its payment.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeOcrReference, counterpartySearchTerms } from '@/lib/invoices/duplicate-payment-guard'
import { distinctiveReferenceKeys, MIN_REFERENCE_KEY_DIGITS } from '@/lib/invoices/ocr-keys'
import { roundOre } from '@/lib/money'
import type { ParsedCamt054Entry, ParsedCamt054SubPayment } from './parse-camt054'

const AMOUNT_TOLERANCE = 0.005
/** Booking dates on the file can drift a day or two from the sync's own date. */
const TRANSACTION_DATE_WINDOW_DAYS = 3

export type SubPaymentMatchStatus = 'matched' | 'ambiguous' | 'unmatched'

export interface MatchedInvoiceRef {
  type: 'supplier_invoice' | 'invoice'
  id: string
  counterpartyName: string | null
  reference: string | null
  remainingAmount: number
  /** Set when the invoice already has a settlement verifikat awaiting bank match. */
  existingJournalEntryId: string | null
}

export interface SubPaymentMatch {
  subPayment: ParsedCamt054SubPayment
  status: SubPaymentMatchStatus
  invoice: MatchedInvoiceRef | null
  /** Present when status is 'ambiguous': every candidate that matched. */
  candidates?: MatchedInvoiceRef[]
}

export interface TransactionMatch {
  id: string
  date: string
  amount: number
}

export interface EntryProposal {
  entry: ParsedCamt054Entry
  transaction: TransactionMatch | null
  transactionMatchStatus: 'matched' | 'ambiguous' | 'not_found'
  subPayments: SubPaymentMatch[]
  /** Every sub-payment matched, exactly one transaction found, and the matched sum closes the entry. */
  fullyExplained: boolean
}

export async function matchNotificationEntries(
  supabase: SupabaseClient,
  companyId: string,
  entries: ParsedCamt054Entry[],
): Promise<EntryProposal[]> {
  const [supplierInvoices, customerInvoices] = await Promise.all([
    fetchOpenSupplierInvoices(supabase, companyId),
    fetchOpenCustomerInvoices(supabase, companyId),
  ])

  const proposals: EntryProposal[] = []
  for (const entry of entries) {
    const transactionResult = await findTransactionForEntry(supabase, companyId, entry)
    const pool = entry.direction === 'DBIT' ? supplierInvoices : customerInvoices

    const subPayments = entry.subPayments.map((sp) => matchSubPayment(sp, pool))

    const matchedSum = roundOre(
      subPayments
        .filter((m) => m.status === 'matched')
        .reduce((sum, m) => sum + (m.invoice?.remainingAmount ?? 0), 0),
    )
    const fullyExplained =
      transactionResult.status === 'matched' &&
      subPayments.length > 0 &&
      subPayments.every((m) => m.status === 'matched') &&
      Math.abs(matchedSum - entry.amount) < AMOUNT_TOLERANCE

    proposals.push({
      entry,
      transaction: transactionResult.transaction,
      transactionMatchStatus: transactionResult.status,
      subPayments,
      fullyExplained,
    })
  }
  return proposals
}

async function findTransactionForEntry(
  supabase: SupabaseClient,
  companyId: string,
  entry: ParsedCamt054Entry,
): Promise<{ status: 'matched' | 'ambiguous' | 'not_found'; transaction: TransactionMatch | null }> {
  const dateMs = new Date(entry.bookingDate).getTime()
  const dayMs = 24 * 3600 * 1000
  const dateLow = new Date(dateMs - TRANSACTION_DATE_WINDOW_DAYS * dayMs).toISOString().split('T')[0]
  const dateHigh = new Date(dateMs + TRANSACTION_DATE_WINDOW_DAYS * dayMs).toISOString().split('T')[0]
  const signedAmount = entry.direction === 'DBIT' ? -entry.amount : entry.amount
  const low = roundOre(signedAmount - AMOUNT_TOLERANCE)
  const high = roundOre(signedAmount + AMOUNT_TOLERANCE)

  const { data } = await supabase
    .from('transactions')
    .select('id, date, amount')
    .eq('company_id', companyId)
    .eq('is_business', true)
    .is('journal_entry_id', null)
    .gte('amount', Math.min(low, high))
    .lte('amount', Math.max(low, high))
    .gte('date', dateLow)
    .lte('date', dateHigh)
    .order('date', { ascending: false })
    .limit(5)

  const rows = (data ?? []) as TransactionMatch[]
  if (rows.length === 0) return { status: 'not_found', transaction: null }
  if (rows.length > 1) return { status: 'ambiguous', transaction: null }
  return { status: 'matched', transaction: rows[0] }
}

interface InvoicePoolRow {
  type: 'supplier_invoice' | 'invoice'
  id: string
  referenceKeys: string[]
  counterpartyName: string | null
  remainingAmount: number
  existingJournalEntryId: string | null
}

async function fetchOpenSupplierInvoices(
  supabase: SupabaseClient,
  companyId: string,
): Promise<InvoicePoolRow[]> {
  const { data } = await supabase
    .from('supplier_invoices')
    .select('id, supplier_invoice_number, payment_reference, remaining_amount, payment_journal_entry_id, supplier:suppliers(name)')
    .eq('company_id', companyId)
    .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])

  return ((data ?? []) as Array<{
    id: string
    supplier_invoice_number: string | null
    payment_reference: string | null
    remaining_amount: number | null
    payment_journal_entry_id: string | null
    supplier: { name: string | null } | { name: string | null }[] | null
  }>).map((row) => ({
    type: 'supplier_invoice' as const,
    id: row.id,
    referenceKeys: [row.payment_reference, row.supplier_invoice_number]
      .map(normalizeOcrReference)
      .filter((k) => k.length >= MIN_REFERENCE_KEY_DIGITS),
    counterpartyName: supplierOrCustomerName(row.supplier),
    remainingAmount: roundOre(row.remaining_amount ?? 0),
    existingJournalEntryId: row.payment_journal_entry_id,
  }))
}

async function fetchOpenCustomerInvoices(
  supabase: SupabaseClient,
  companyId: string,
): Promise<InvoicePoolRow[]> {
  const { data } = await supabase
    .from('invoices')
    .select('id, invoice_number, remaining_amount, journal_entry_id, customer:customers(name)')
    .eq('company_id', companyId)
    .in('status', ['sent', 'overdue', 'partially_paid'])

  return ((data ?? []) as Array<{
    id: string
    invoice_number: string | null
    remaining_amount: number | null
    journal_entry_id: string | null
    customer: { name: string | null } | { name: string | null }[] | null
  }>).map((row) => ({
    type: 'invoice' as const,
    id: row.id,
    referenceKeys: distinctiveReferenceKeys(row.invoice_number),
    counterpartyName: supplierOrCustomerName(row.customer),
    remainingAmount: roundOre(row.remaining_amount ?? 0),
    existingJournalEntryId: row.journal_entry_id,
  }))
}

function supplierOrCustomerName(
  rel: { name: string | null } | { name: string | null }[] | null,
): string | null {
  if (!rel) return null
  return Array.isArray(rel) ? (rel[0]?.name ?? null) : rel.name
}

function matchSubPayment(sp: ParsedCamt054SubPayment, pool: InvoicePoolRow[]): SubPaymentMatch {
  const refKey = normalizeOcrReference(sp.reference ?? '')
  if (!refKey || refKey.length < MIN_REFERENCE_KEY_DIGITS) {
    return { subPayment: sp, status: 'unmatched', invoice: null }
  }

  // Reference match is required; amount and counterparty-name plausibility
  // narrow it further so a short/reused invoice number can never cross-match
  // the wrong supplier or customer (see plan: "never match on reference alone").
  const referenceHits = pool.filter((row) => row.referenceKeys.includes(refKey))
  const amountHits = referenceHits.filter((row) => Math.abs(row.remainingAmount - sp.amount) < AMOUNT_TOLERANCE)

  const nameNeedle = (sp.counterpartyName ?? '').toLowerCase()
  const plausible = amountHits.filter((row) => {
    const terms = counterpartySearchTerms(row.counterpartyName)
    return terms.length === 0 || terms.some((t) => nameNeedle.includes(t))
  })
  // Fall back to amount-only hits when name data is missing on either side,
  // rather than discarding an otherwise exact reference+amount match.
  const finalHits = plausible.length > 0 ? plausible : amountHits

  if (finalHits.length === 0) return { subPayment: sp, status: 'unmatched', invoice: null }
  if (finalHits.length > 1) {
    return {
      subPayment: sp,
      status: 'ambiguous',
      invoice: null,
      candidates: finalHits.map(toMatchedInvoiceRef),
    }
  }
  return { subPayment: sp, status: 'matched', invoice: toMatchedInvoiceRef(finalHits[0]) }
}

function toMatchedInvoiceRef(row: InvoicePoolRow): MatchedInvoiceRef {
  return {
    type: row.type,
    id: row.id,
    counterpartyName: row.counterpartyName,
    reference: row.referenceKeys[0] ?? null,
    remainingAmount: row.remainingAmount,
    existingJournalEntryId: row.existingJournalEntryId,
  }
}

import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BankgiroNotificationConfirmSchema } from '@/lib/api/schemas'
import { manualLink, linkTransactionToVouchers } from '@/lib/reconciliation/bank-reconciliation'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/reconciliation/bankgiro-notification/confirm
 *
 * Commits one reviewed camt.054 entry: books a settlement verifikat for any
 * matched invoice that doesn't already have one (via the SAME mark-paid
 * routes a user would click through by hand — reused wholesale rather than
 * re-derived here, so cash/accrual routing, the duplicate-payment guard, and
 * orphan-voucher cleanup stay exactly what they are today), then links the
 * resulting verifikat set to the bank transaction the entry explains via the
 * existing manualLink / linkTransactionToVouchers primitives
 * (src/lib/reconciliation/bank-reconciliation.ts) — the same commit path the
 * generic MatchVoucherDialog split uses.
 *
 * `force: true` is passed to the mark-paid calls because the invoice was
 * already matched via the file's exact structured reference
 * (RmtInf/Strd/RfrdDocInf/Nb) plus amount and counterparty-name plausibility
 * (src/lib/reconciliation/bankgiro-notification/match.ts) — stronger evidence
 * than the duplicate-payment guard's own fuzzy sweep, which would otherwise
 * flag the very row this entry is about to link.
 */
export const POST = withRouteContext(
  'reconciliation.bankgiro_notification.confirm',
  async (request, ctx) => {
    const { supabase, companyId, user, log } = ctx

    const validation = await validateBody(request, BankgiroNotificationConfirmSchema)
    if (!validation.success) return validation.response
    const { entry, transaction_id, allocations } = validation.data

    if (allocations.length === 0) {
      return NextResponse.json({ error: 'Inga fakturor att bokföra/matcha.' }, { status: 400 })
    }

    const journalEntryIds: string[] = []
    for (const alloc of allocations) {
      if (alloc.existing_journal_entry_id) {
        journalEntryIds.push(alloc.existing_journal_entry_id)
        continue
      }
      const booked = await bookInvoicePayment(request, alloc.type, alloc.id, entry.booking_date, alloc.amount)
      if (!booked.ok) {
        log.warn('bankgiro notification: booking failed, aborting entry', {
          invoiceType: alloc.type,
          invoiceId: alloc.id,
          error: booked.error,
        })
        return NextResponse.json(
          { error: `Kunde inte bokföra betalningen för faktura ${alloc.id}: ${booked.error}` },
          { status: 400 },
        )
      }
      journalEntryIds.push(booked.journalEntryId)
    }

    const linkResult =
      journalEntryIds.length === 1
        ? await manualLink(supabase, companyId!, transaction_id, journalEntryIds[0], user.id)
        : await linkTransactionToVouchers(
            supabase,
            companyId!,
            transaction_id,
            journalEntryIds.map((id, i) => ({ journal_entry_id: id, amount: allocations[i].amount })),
            user.id,
          )

    if (!linkResult.success) {
      // The payment vouchers (if any were freshly booked above) are real,
      // correct bookings on their own — only the bank-side link failed (e.g.
      // the transaction was matched by someone else in the meantime). Leave
      // them booked; the entry simply falls back to manual matching in the
      // normal unmatched-entries view, same as any other booked-but-unlinked
      // payment.
      return NextResponse.json({ error: linkResult.error }, { status: 400 })
    }

    await supabase.from('bankgiro_notification_entries').insert({
      company_id: companyId,
      acct_svcr_ref: entry.acct_svcr_ref,
      transaction_id,
      direction: entry.direction,
      amount: entry.amount,
      booking_date: entry.booking_date,
      sub_payment_count: allocations.length,
      confirmed_by: user.id,
    })

    return NextResponse.json({ data: { success: true, journal_entry_ids: journalEntryIds } })
  },
  { requireWrite: true },
)

async function bookInvoicePayment(
  request: Request,
  type: 'supplier_invoice' | 'invoice',
  id: string,
  paymentDate: string,
  amount: number,
): Promise<{ ok: true; journalEntryId: string } | { ok: false; error: string }> {
  const origin = new URL(request.url).origin
  const path =
    type === 'supplier_invoice' ? `/api/supplier-invoices/${id}/mark-paid` : `/api/invoices/${id}/mark-paid`

  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      cookie: request.headers.get('cookie') ?? '',
    },
    body: JSON.stringify({
      payment_date: paymentDate,
      force: true,
      ...(type === 'supplier_invoice' ? { amount } : {}),
    }),
  })

  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; journal_entry_id?: string; error?: { message?: string } }
    | null

  if (!res.ok || !json?.success || !json.journal_entry_id) {
    const upstreamMessage = json?.error?.message
    const safeMessage = getErrorMessage(upstreamMessage, { statusCode: res.status })
    return { ok: false, error: safeMessage }
  }
  return { ok: true, journalEntryId: json.journal_entry_id }
}

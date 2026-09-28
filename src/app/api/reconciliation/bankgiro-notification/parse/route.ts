import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { parseCamt054, detectCamt054 } from '@/lib/reconciliation/bankgiro-notification/parse-camt054'
import { matchNotificationEntries } from '@/lib/reconciliation/bankgiro-notification/match'

/**
 * POST /api/reconciliation/bankgiro-notification/parse
 *
 * Accepts a camt.054 "Återredovisning" XML file, parses its lump entries and
 * sub-payments, and matches them against open invoices and already-synced,
 * unmatched bank transactions. Read-only: nothing is booked or linked here,
 * see .../confirm for that. The review UI drives one "Bekräfta" per entry
 * off this response.
 */
export const POST = withRouteContext(
  'reconciliation.bankgiro_notification.parse',
  async (request, ctx) => {
    const { supabase, companyId, log } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    if (!file) {
      return NextResponse.json({ error: 'Ingen fil bifogad.' }, { status: 400 })
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: 'Filen är för stor (max 5 MB).' }, { status: 400 })
    }

    const arrayBuffer = await file.arrayBuffer()
    const content = decodeFileContent(arrayBuffer)

    if (!detectCamt054(content, file.name)) {
      return NextResponse.json(
        { error: 'Filen ser inte ut som en camt.054 Återredovisning-fil.' },
        { status: 400 },
      )
    }

    let parsed
    try {
      parsed = parseCamt054(content)
    } catch (err) {
      log.error('camt.054 parse failed', err as Error)
      return NextResponse.json({ error: 'Filen kunde inte tolkas.' }, { status: 400 })
    }

    if (parsed.entries.length === 0) {
      return NextResponse.json(
        { error: 'Inga poster hittades i filen.', issues: parsed.issues },
        { status: 400 },
      )
    }

    // Skip entries already fully resolved in an earlier upload of the same
    // period (dedupe on the lump entry's own bank reference).
    const acctSvcrRefs = parsed.entries.map((e) => e.acctSvcrRef).filter((r): r is string => !!r)
    const { data: alreadyHandled } =
      acctSvcrRefs.length > 0
        ? await supabase
            .from('bankgiro_notification_entries')
            .select('acct_svcr_ref')
            .eq('company_id', companyId)
            .in('acct_svcr_ref', acctSvcrRefs)
        : { data: [] as { acct_svcr_ref: string }[] }
    const handledRefs = new Set((alreadyHandled ?? []).map((r) => r.acct_svcr_ref))

    const freshEntries = parsed.entries.filter((e) => !e.acctSvcrRef || !handledRefs.has(e.acctSvcrRef))
    const skippedCount = parsed.entries.length - freshEntries.length

    const proposals = await matchNotificationEntries(supabase, companyId!, freshEntries)

    return NextResponse.json({
      data: {
        proposals,
        issues: parsed.issues,
        already_handled_count: skippedCount,
      },
    })
  },
)

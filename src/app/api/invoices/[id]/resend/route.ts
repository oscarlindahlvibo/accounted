import { NextResponse } from 'next/server'
import { z } from 'zod'
import { renderInvoicePdfBuffer } from '@/lib/invoices/render-invoice-pdf'
import { getEmailService } from '@/lib/email/service'
import { resolveInvoiceSender } from '@/lib/email/invoice-sender'
import {
  generateInvoiceEmailHtml,
  generateInvoiceEmailText,
  generateInvoiceEmailSubject,
} from '@/lib/email/invoice-templates'
import { invoicePdfFilename } from '@/lib/invoices/pdf-filename'
import { reserveInvoiceDelivery, sendTrackedInvoiceEmail } from '@/lib/invoices/invoice-deliveries'
import { withRouteContext } from '@/lib/api/with-route-context'
import {
  EMAIL_PATTERN,
  resolveInvoiceEmailRecipients,
  resolveInvoiceReplyTo,
} from '@/lib/invoices/email-recipients'
import { ensureInitialized } from '@/lib/init'
import { guardSandbox } from '@/lib/sandbox/guard'
import { requireCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { CompanySettings, Customer, Invoice, InvoiceItem } from '@/types'

ensureInitialized()

const ResendSchema = z.object({
  // Optional override when the customer wants the copy at another address.
  to: z.string().trim().email().max(254).optional(),
})

/**
 * Re-sends a copy of an already issued invoice (customer lost it). Pure
 * delivery: never changes status, numbering, bookkeeping or payment link, and
 * emits no events. Drafts go through /send, cancelled invoices are refused.
 */
export const POST = withRouteContext(
  'invoice.resend',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log } = ctx
    const opLog = log.child({ invoiceId: id })

    const bodyText = await request.text()
    let rawBody: unknown = {}
    if (bodyText) {
      try { rawBody = JSON.parse(bodyText) } catch {
        return NextResponse.json({ error: 'Ogiltig förfrågan' }, { status: 400 })
      }
    }
    const parsed = ResendSchema.safeParse(rawBody)
    if (!parsed.success) return NextResponse.json({ error: 'Ogiltig e-postadress' }, { status: 400 })

    const blocked = await guardSandbox(supabase, companyId)
    if (blocked) return blocked
    const capBlocked = await requireCapability(supabase, companyId, CAPABILITY.email_send)
    if (capBlocked) return capBlocked

    const emailService = getEmailService()
    if (!emailService.isConfigured()) {
      return NextResponse.json({ error: 'E-post är inte konfigurerat' }, { status: 503 })
    }

    const { data: invoice } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()
    if (!invoice) return NextResponse.json({ error: 'Fakturan hittades inte' }, { status: 404 })
    if (invoice.status === 'draft' || invoice.status === 'cancelled' || !invoice.invoice_number) {
      return NextResponse.json({ error: 'Endast utfärdade fakturor kan skickas igen' }, { status: 409 })
    }

    const { data: company } = await supabase
      .from('company_settings').select('*').eq('company_id', companyId).single()
    if (!company) return NextResponse.json({ error: 'Företagsinställningar saknas' }, { status: 500 })

    if (!invoice.customer) {
      return NextResponse.json({ error: 'Fakturan saknar kund' }, { status: 422 })
    }
    const customer = invoice.customer as Customer
    const toAddress = (parsed.data.to ?? customer.email ?? '').trim()
    if (!toAddress || !EMAIL_PATTERN.test(toAddress)) {
      return NextResponse.json({ error: 'Kunden saknar e-postadress' }, { status: 422 })
    }
    const recipients = resolveInvoiceEmailRecipients({
      to: toAddress,
      configuredCc: company.invoice_email_cc_addresses,
      configuredBcc: company.invoice_email_bcc_addresses,
      customerCc: customer.invoice_email_cc_addresses,
      customerBcc: customer.invoice_email_bcc_addresses,
    })

    const items = (invoice.items as InvoiceItem[]).sort((a, b) => a.sort_order - b.sort_order)
    let originalInvoiceNumber: string | undefined
    if (invoice.credited_invoice_id) {
      const { data: original } = await supabase
        .from('invoices')
        .select('invoice_number, external_invoice_number')
        .eq('id', invoice.credited_invoice_id)
        .eq('company_id', companyId)
        .single()
      originalInvoiceNumber = original?.invoice_number ?? original?.external_invoice_number ?? undefined
    }

    // Render as 'sent' so the copy matches what the customer originally got
    // (no PAID/OVERDUE stamp variations).
    const renderable = { ...(invoice as Invoice), status: 'sent' as const }
    const { buffer: pdfBuffer } = await renderInvoicePdfBuffer({
      invoice: renderable,
      customer,
      items,
      company: company as CompanySettings,
      originalInvoiceNumber,
    })

    const replyTo = resolveInvoiceReplyTo(company as CompanySettings, user.email)
    const emailData = { invoice: renderable, customer, company: company as CompanySettings, replyTo }
    const filename = invoicePdfFilename({
      companyName: company.company_name,
      customerName: customer.name,
      invoiceNumber: invoice.invoice_number,
      invoiceId: invoice.id,
      invoiceDate: invoice.invoice_date,
      documentType: invoice.document_type,
      isCreditNote: !!invoice.credited_invoice_id,
    })

    let deliveryId: string
    try {
      deliveryId = await reserveInvoiceDelivery({ supabase, companyId: companyId!, userId: user.id, invoiceId: id })
    } catch (err) {
      opLog.error('resend: failed to reserve delivery', err as Error)
      return NextResponse.json({ error: 'Kunde inte förbereda utskicket' }, { status: 500 })
    }

    const result = await sendTrackedInvoiceEmail({
      supabase,
      emailService,
      companyId: companyId!,
      userId: user.id,
      invoiceId: id,
      deliveryId,
      to: recipients.to,
      cc: recipients.cc,
      bcc: recipients.bcc,
      subject: `Kopia: ${generateInvoiceEmailSubject(emailData)}`,
      html: generateInvoiceEmailHtml(emailData),
      text: generateInvoiceEmailText(emailData),
      replyTo,
      fromName: company.company_name,
      from: await resolveInvoiceSender(supabase, companyId!, company.company_name),
      filename,
      pdfBuffer,
    })
    if (!result.success) {
      opLog.error('resend: provider failed', new Error(result.error || 'Unknown'))
      return NextResponse.json({ error: 'E-postleverantören kunde inte skicka mejlet' }, { status: 502 })
    }
    opLog.info('invoice copy sent', { deliveryId, to: recipients.to.length })
    return NextResponse.json({ data: { delivery_id: deliveryId, to: recipients.to } })
  },
)

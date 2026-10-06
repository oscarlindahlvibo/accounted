import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { pollIngestMailbox } from '@/lib/vibo-ingest/mail-poll'

/**
 * GET /api/extensions/invoice-inbox/ingest/mail/cron: Vibo fork. Pulls invoices
 * and underlag from a Google mail source into each company's Dokumentinkorg.
 * Does nothing (200, configured:false) until the INGEST_* env vars are set.
 */
export const maxDuration = 300

export const GET = withCronContext('cron.ingest_mail', async () => {
  const result = await pollIngestMailbox(createServiceClientNoCookies())
  return NextResponse.json({ data: result })
})

import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { syncDriveFolders } from '@/lib/vibo-ingest/drive-sync'

/**
 * GET /api/extensions/invoice-inbox/ingest/drive/cron: Vibo fork. Pulls invoices
 * and underlag from a Google drive source into each company's Dokumentinkorg.
 * Does nothing (200, configured:false) until the INGEST_* env vars are set.
 */
export const maxDuration = 300

export const GET = withCronContext('cron.ingest_drive', async () => {
  const result = await syncDriveFolders(createServiceClientNoCookies())
  return NextResponse.json({ data: result })
})

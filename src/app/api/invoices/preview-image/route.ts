import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { privateNoStore } from '@/lib/api/private-no-store'
import { rasterizePdf } from '@/lib/ai/rasterize-pdf'

const MAX_PDF_BYTES = 8 * 1024 * 1024
const MAX_PAGES = 6

/**
 * POST /api/invoices/preview-image: Vibo fork. Turns the editor's preview PDF
 * (raw application/pdf body, as returned by /api/invoices/preview-pdf) into
 * PNG pages, for browsers and web apps without an inline PDF viewer.
 */
export const POST = withRouteContext('invoice.preview_image', async (request, { log }) => {
  const bytes = Buffer.from(await request.arrayBuffer())
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_BYTES || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    return privateNoStore(NextResponse.json({ error: 'Ogiltig PDF' }, { status: 400 }))
  }
  const result = await rasterizePdf(bytes, { maxPages: MAX_PAGES, dpi: 110 })
  if (!result.ok) {
    log.warn('preview image rasterize failed', { reason: result.reason, error: result.error })
    return privateNoStore(NextResponse.json({ error: 'Förhandsvisningen kunde inte ritas' }, { status: 502 }))
  }
  return privateNoStore(
    NextResponse.json({
      data: { pages: result.pages.map((p) => 'data:image/png;base64,' + p.toString('base64')), pageCount: result.pageCount },
    }),
  )
})

'use client'

import { useEffect, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * The preview as page images, for browsers and web apps without an inline PDF
 * viewer (Safari web apps, kiosk/remote browsers). Sends the preview blob to
 * /api/invoices/preview-image and draws the PNG pages it returns.
 */
export function PdfPageImages({ url }: { url: string }) {
  const [pages, setPages] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    ;(async () => {
      try {
        const blob = await (await fetch(url, { signal: controller.signal })).blob()
        const res = await fetch('/api/invoices/preview-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/pdf' },
          body: blob,
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(String(res.status))
        const json = (await res.json()) as { data?: { pages?: string[] } }
        setPages(json.data?.pages ?? [])
        setFailed(false)
      } catch (err) {
        if ((err as { name?: string }).name !== 'AbortError') setFailed(true)
      }
    })()
    return () => controller.abort()
    // The previous pages stay visible while a new render loads: no blanking per edit.
  }, [url])

  if (failed && !pages) {
    return <p className="p-4 text-sm text-muted-foreground">Förhandsvisningen kunde inte visas. Använd pilikonen för att öppna den i en egen flik.</p>
  }
  if (!pages) return <Skeleton className="h-full w-full rounded-lg" />
  return (
    <div className="h-full overflow-y-auto rounded-lg border border-border bg-background">
      {pages.map((src, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={i} src={src} alt={'Sida ' + (i + 1)} className="mx-auto mb-2 block w-full max-w-[900px]" />
      ))}
    </div>
  )
}

import type { SupabaseClient } from '@supabase/supabase-js'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { ingestFile, resolveOwnerId } from './shared'

const BATCH = 15
const DONE_BOX = 'Accounted-behandlade'
const NO_ATTACHMENT_BOX = 'Accounted-utan-bilaga'
const UNROUTED_BOX = 'Accounted-ej-routad'
const FAILED_BOX = 'Accounted-fel'

export interface MailPollResult {
  configured: boolean
  messages: number
  ingested: number
  skipped: number
  failed: number
}

function addressesOf(parsed: Awaited<ReturnType<typeof simpleParser>>): string[] {
  const out = new Set<string>()
  for (const field of [parsed.to, parsed.cc]) {
    const list = Array.isArray(field) ? field : field ? [field] : []
    for (const g of list) for (const a of g.value ?? []) if (a.address) out.add(a.address.toLowerCase())
  }
  for (const h of ['delivered-to', 'x-original-to', 'envelope-to']) {
    const v = parsed.headers.get(h)
    for (const s of Array.isArray(v) ? v : v ? [v] : []) {
      const m = String(s).toLowerCase().match(/[^\s<>,;]+@[^\s<>,;]+/g)
      m?.forEach((a) => out.add(a))
    }
  }
  return [...out]
}

/**
 * Polls one Google mailbox (IMAP) for mail with invoice/underlag attachments
 * and puts them in the right company's Dokumentinkorg. Routing is by the
 * recipient address; the ingest_mail_routes table maps address -> company.
 * A plus-tag (ga+lev@domain) falls back to the plain address.
 */
export async function pollIngestMailbox(supabase: SupabaseClient): Promise<MailPollResult> {
  const user = process.env.INGEST_IMAP_USER
  const pass = process.env.INGEST_IMAP_PASS
  const result: MailPollResult = { configured: false, messages: 0, ingested: 0, skipped: 0, failed: 0 }
  if (!user || !pass) return result
  const { data: routeRows } = await supabase.from('ingest_mail_routes').select('address, company_id')
  const routeMap = new Map((routeRows ?? []).map((r) => [String(r.address).toLowerCase(), String(r.company_id)]))
  if (routeMap.size === 0) return result
  result.configured = true

  const client = new ImapFlow({
    host: process.env.INGEST_IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.INGEST_IMAP_PORT || 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  })
  await client.connect()
  const ownerCache = new Map<string, string | null>()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const found = (await client.search({ seen: false }, { uid: true })) || []
      const uids = found.slice(0, BATCH)
      const raw: { uid: number; source: Buffer }[] = []
      for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
        if (msg.source) raw.push({ uid: msg.uid, source: msg.source })
      }
      const moves: { uid: number; box: string }[] = []
      for (const { uid, source } of raw) {
        result.messages++
        const parsed = await simpleParser(source)
        const to = addressesOf(parsed)
        const companyId = to.map((a) => routeMap.get(a) ?? routeMap.get(a.replace(/\+[^@]*@/, '@'))).find(Boolean)
        if (!companyId) { moves.push({ uid, box: UNROUTED_BOX }); result.skipped++; continue }
        if (!ownerCache.has(companyId)) ownerCache.set(companyId, await resolveOwnerId(supabase, companyId))
        const ownerId = ownerCache.get(companyId)
        if (!ownerId) { moves.push({ uid, box: FAILED_BOX }); result.failed++; continue }

        const files = (parsed.attachments ?? []).filter((a) => {
          if (!a.filename && a.contentDisposition !== 'attachment') return false
          // Skip tiny inline images (signature logos).
          if (a.contentDisposition === 'inline' && a.size < 15_000 && a.contentType.startsWith('image/')) return false
          return true
        })
        if (files.length === 0) { moves.push({ uid, box: NO_ATTACHMENT_BOX }); result.skipped++; continue }

        let ok = 0
        let bad = 0
        for (const f of files) {
          const outcome = await ingestFile(
            supabase, ownerId, companyId,
            { name: f.filename || 'bilaga', buffer: f.content, type: f.contentType },
            'email',
            {
              from: parsed.from?.text ?? null,
              subject: parsed.subject ?? null,
              receivedAt: (parsed.date ?? new Date()).toISOString(),
              messageId: parsed.messageId ?? null,
              bodyText: (parsed.text ?? '').slice(0, 5000),
            },
          )
          if (outcome === 'ingested') ok++
          else bad++
        }
        result.ingested += ok
        if (ok === 0 && bad > 0) { moves.push({ uid, box: FAILED_BOX }); result.failed++ }
        else moves.push({ uid, box: DONE_BOX })
      }
      for (const { uid, box } of moves) {
        try {
          await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true })
          await client.mailboxCreate(box).catch(() => undefined)
          await client.messageMove({ uid }, box, { uid: true })
        } catch (err) {
          console.error('[vibo-ingest/mail] move failed:', err instanceof Error ? err.message : err)
        }
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => undefined)
  }
  return result
}

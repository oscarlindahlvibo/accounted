#!/usr/bin/env npx tsx
/**
 * Archives Spiris export documents in Vibogruppen:
 *  kundfakturor/<year>/FakturaNNN.pdf, KreditfakturaNNN.pdf  -> underlag on the invoice's payment verifikat (else registration verifikat, else floating)
 *  kundfakturor/<year>/Betalningspåminnelse*.pdf              -> floating (archive)
 *  lonebesked/<year>/Lönebesked YYYY-MM-DD.pdf                -> underlag on every voucher whose text carries that date and 'lön' (else floating)
 *  agi, semester, franvaro, ejkopplade                        -> floating (archive)
 * Dry run by default; --apply writes. Never touches journal entries or lines.
 * npx tsx scripts/archive-import/attach-extra.ts --company <uuid> --dir <dir> [--only kundfakturor|lon|other] [--apply]
 */
import { createClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { uploadDocument } from '../../src/lib/core/documents/document-service'

const arg = (f: string) => { const i = process.argv.indexOf(f); const v = process.argv[i + 1]; return i >= 0 && v && !v.startsWith('--') ? v : null }
const C = arg('--company')!; const DIR = resolve(arg('--dir')!); const ONLY = arg('--only'); const APPLY = process.argv.includes('--apply')
dotenv({ path: resolve(process.cwd(), '.env') })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const MIME: Record<string, string> = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv' }
async function all(table: string, sel: string, f: (q: any) => any) { const out: any[] = []; for (let o = 0; ; o += 1000) { const { data, error } = await f(sb.from(table).select(sel)).range(o, o + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break } return out }

async function main() {
  console.log(APPLY ? 'APPLY' : 'DRY RUN')
  const { data: own } = await sb.from('company_members').select('user_id').eq('company_id', C).eq('role', 'owner').order('created_at').limit(1)
  const userId = own![0].user_id as string
  const invs = await all('invoices', 'id,invoice_number,journal_entry_id', q => q.eq('company_id', C))
  const byNo = new Map(invs.map(i => [String(i.invoice_number), i]))
  const pays = await all('invoice_payments', 'invoice_id,journal_entry_id,payment_date', q => q.eq('company_id', C).not('journal_entry_id', 'is', null))
  const payJe = new Map<string, string>(); for (const p of pays.sort((a, b) => (a.payment_date < b.payment_date ? -1 : 1))) if (!payJe.has(p.invoice_id)) payJe.set(p.invoice_id, p.journal_entry_id)
  const entries = await all('journal_entries', 'id,description,status', q => q.eq('company_id', C).eq('status', 'posted').ilike('description', '%lön%'))
  const stats: Record<string, number> = {}; const issues: any[] = []
  const bump = (k: string) => (stats[k] = (stats[k] ?? 0) + 1)

  async function put(path: string, name: string, jeIds: (string | null)[], key: string, label: string) {
    const ext = extname(name).toLowerCase(); const type = MIME[ext]
    if (!type) { bump(label + ':unsupported'); issues.push({ name, why: 'unsupported type' }); return }
    if (!APPLY) { bump(label + (jeIds[0] ? ':anchored' : ':floating')); return }
    const buf = readFileSync(path); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    for (const je of jeIds) {
      try {
        await uploadDocument(sb, userId, C, { name, buffer: ab, type }, { upload_source: 'file_upload', ...(je ? { journal_entry_id: je } : {}), extractionOwner: 'none', idempotency_key: (je ?? 'archive') + ':' + key })
        bump(label + (je ? ':anchored' : ':floating'))
      } catch (e: any) { bump(label + ':error'); issues.push({ name, why: String(e?.message ?? e).slice(0, 140) }) }
    }
  }

  const dirs = (d: string) => (existsSync(join(DIR, d)) ? readdirSync(join(DIR, d)).sort() : [])
  if (!ONLY || ONLY === 'kundfakturor') for (const y of dirs('kundfakturor')) for (const f of readdirSync(join(DIR, 'kundfakturor', y))) {
    const m = f.match(/^(Faktura|Kreditfaktura)(\d+)/)
    const p = join(DIR, 'kundfakturor', y, f)
    if (!m) { await put(p, f, [null], 'rem:' + y + f, 'paminnelse'); continue }
    const inv = byNo.get(m[2])
    if (!inv) { bump('faktura:noinvoice'); issues.push({ name: f, why: 'no invoice' }); continue }
    const je = payJe.get(inv.id) ?? inv.journal_entry_id ?? null
    await put(p, f, [je], 'inv:' + inv.id, m[1] === 'Faktura' ? 'faktura' : 'kreditfaktura')
  }
  if (!ONLY || ONLY === 'lon') for (const y of dirs('lonebesked')) for (const f of readdirSync(join(DIR, 'lonebesked', y))) {
    const d = f.match(/(\d{4}-\d{2}-\d{2})/)?.[1]
    const targets = d ? entries.filter(e => (e.description ?? '').includes(d)).map(e => e.id) : []
    await put(join(DIR, 'lonebesked', y, f), f, targets.length ? targets : [null], 'lon:' + y + f, targets.length ? 'lonebesked' : 'lonebesked-floating')
  }
  if (!ONLY || ONLY === 'other') for (const d of ['agi', 'semester', 'franvaro', 'ejkopplade']) for (const y of dirs(d)) for (const f of readdirSync(join(DIR, d, y))) await put(join(DIR, d, y, f), f, [null], d + ':' + y + f, d)
  console.log(stats); writeFileSync('/tmp/extra-issues.json', JSON.stringify(issues, null, 1)); console.log('issues:', issues.length)
}
main().catch(e => { console.error(e); process.exit(1) })

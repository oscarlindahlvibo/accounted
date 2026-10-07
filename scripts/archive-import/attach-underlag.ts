#!/usr/bin/env npx tsx
/**
 * Attaches underlag files (named A<nr>_<name>.<ext>, one folder per fiscal year
 * "YYYY-MM-DD - YYYY-MM-DD") to SIE-migrated verifikat, using the app's own plan
 * builder and uploadDocument. Only rows the planner resolves to exactly one
 * verifikat ('matched') are attached. Dry run by default; --apply writes.
 * npx tsx scripts/archive-import/attach-underlag.ts --company <uuid> --dir <dir> [--year 2024-07-01] [--apply]
 */
import { createClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { buildUnderlagPlan } from '../../src/lib/documents/underlag-import'
import { uploadDocument } from '../../src/lib/core/documents/document-service'

const arg = (f: string) => { const i = process.argv.indexOf(f); const v = process.argv[i + 1]; return i >= 0 && v && !v.startsWith('--') ? v : null }
const COMPANY = arg('--company')!; const DIR = arg('--dir')!; const ONLY = arg('--year'); const APPLY = process.argv.includes('--apply')
dotenv({ path: resolve(process.cwd(), '.env') })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const MIME: Record<string, string> = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv', '.rtf': 'application/rtf' }

async function main() {
  console.log(APPLY ? 'APPLY' : 'DRY RUN')
  const { data: own } = await sb.from('company_members').select('user_id').eq('company_id', COMPANY).eq('role', 'owner').order('created_at').limit(1)
  const userId = own![0].user_id as string
  const { data: periods } = await sb.from('fiscal_periods').select('id,period_start,period_end').eq('company_id', COMPANY)
  const report: any[] = []
  for (const folder of readdirSync(DIR).sort()) {
    const start = folder.slice(0, 10)
    if (ONLY && ONLY !== start) continue
    const period = periods?.find(p => p.period_start === start)
    if (!period) { console.log(folder, 'no fiscal period'); continue }
    const files = readdirSync(join(DIR, folder))
    const plan = await buildUnderlagPlan(sb, COMPANY, files, period.id)
    console.log(folder, JSON.stringify(plan.summary), plan.no_source_refs ? 'NO SOURCE REFS' : '')
    for (const r of plan.rows) if (r.status !== 'matched') report.push({ folder, file: r.file_name, status: r.status })
    if (!APPLY) continue
    let ok = 0, fail = 0
    for (const r of plan.rows) {
      if (r.status !== 'matched' || !r.journal_entry_id) continue
      const ext = extname(r.file_name).toLowerCase()
      const type = MIME[ext]
      if (!type) { report.push({ folder, file: r.file_name, status: 'unsupported_type' }); fail++; continue }
      try {
        const buf = readFileSync(join(DIR, folder, r.file_name))
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
        await uploadDocument(sb, userId, COMPANY, { name: r.file_name, buffer: ab, type }, { upload_source: 'file_upload', journal_entry_id: r.journal_entry_id, extractionOwner: 'none', idempotency_key: r.journal_entry_id })
        ok++
      } catch (e: any) { fail++; report.push({ folder, file: r.file_name, status: 'error', msg: String(e?.message ?? e).slice(0, 160) }) }
    }
    console.log(`  attached=${ok} failed=${fail}`)
  }
  writeFileSync('/tmp/underlag-report.json', JSON.stringify(report, null, 1))
  console.log('not attached / issues:', report.length, '(see /tmp/underlag-report.json)')
}
main().catch(e => { console.error(e); process.exit(1) })

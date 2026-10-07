import { createClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
const arg = (f: string) => { const i = process.argv.indexOf(f); const v = process.argv[i + 1]; return i >= 0 && v && !v.startsWith('--') ? v : null }
const COMPANY = arg('--company')!; const CSV = arg('--csv')!; const APPLY = process.argv.includes('--apply')
dotenv({ path: resolve(process.cwd(), '.env') })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const nk = (n: string) => n.trim().toLowerCase()
async function main() {
  const lines = readFileSync(resolve(process.cwd(), CSV), 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim())
  const head = lines[0].split(';'); const ix = (n: string) => head.indexOf(n)
  const rows = lines.slice(1).map(l => l.split(';')).map(c => ({ num: (c[ix('CustomerNumber')] || '').trim(), name: (c[ix('Name')] || '').trim(), email: (c[ix('EmailAddress')] || '').trim().toLowerCase() }))
  const { data: custs, error } = await sb.from('customers').select('id,name,email,customer_number').eq('company_id', COMPANY)
  if (error) { console.error(error.message); process.exit(1) }
  const byName = new Map<string, any[]>()
  for (const c of custs ?? []) byName.set(nk(c.name), [...(byName.get(nk(c.name)) ?? []), c])
  const taken = new Set((custs ?? []).map(c => c.customer_number).filter(Boolean))
  const ups: { id: string; num: string }[] = []; let none = 0, skipped = 0
  for (const r of rows) {
    const cands = byName.get(nk(r.name)) ?? []
    const c = cands.length === 1 ? cands[0] : cands.find(x => (x.email ?? '').toLowerCase() === r.email)
    if (!c) { none++; continue }
    if (c.customer_number || taken.has(r.num)) { skipped++; continue }
    taken.add(r.num); ups.push({ id: c.id, num: r.num })
  }
  console.log({ toUpdate: ups.length, noMatch: none, skipped })
  if (!APPLY) return
  let ok = 0, fail = 0
  for (const u of ups) { const { error: e } = await sb.from('customers').update({ customer_number: u.num }).eq('id', u.id).eq('company_id', COMPANY); e ? (fail++, console.log(e.message)) : ok++ }
  console.log({ updated: ok, failed: fail })
}
main()

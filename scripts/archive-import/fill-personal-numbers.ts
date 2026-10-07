#!/usr/bin/env npx tsx
/**
 * Fills customers.personal_number for INDIVIDUAL customers from a Spiris
 * Customers_Export CSV, matched on customer_number. Encrypts with the app's own
 * helper. Dry run by default; --apply writes.
 * npx tsx scripts/archive-import/fill-personal-numbers.ts --company <uuid> --csv <file> [--apply]
 */
import { createClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { encryptCustomerPersonalNumber } from '../../src/lib/customers/protect-personal-number'

const arg = (f: string) => { const i = process.argv.indexOf(f); const v = process.argv[i + 1]; return i >= 0 && v && !v.startsWith('--') ? v : null }
const COMPANY = arg('--company'); const CSV = arg('--csv'); const APPLY = process.argv.includes('--apply')
if (!COMPANY || !CSV) { console.error('Usage: --company <uuid> --csv <file> [--apply]'); process.exit(1) }
dotenv({ path: resolve(process.cwd(), '.env') })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

function normalize(raw: string): string | null {
  const d = raw.trim().replace(/\s/g, '')
  if (/x/i.test(d)) return null
  const digits = d.replace(/\D/g, '')
  if (digits.length === 10) return `${digits.slice(0, 6)}-${digits.slice(6)}`
  if (digits.length === 12) return `${digits.slice(0, 8)}-${digits.slice(8)}`
  return null
}

async function main() {
  const text = readFileSync(resolve(process.cwd(), CSV!), 'utf8').replace(/^﻿/, '')
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  const head = lines[0].split(';')
  const ix = (n: string) => head.indexOf(n)
  const rows = lines.slice(1).map(l => l.split(';')).map(c => ({ num: (c[ix('CustomerNumber')] || '').trim(), name: (c[ix('Name')] || '').trim(), pn: (c[ix('CorporateIdentityNumber')] || '').trim(), email: (c[ix('EmailAddress')] || '').trim().toLowerCase() }))
  const { data: custs, error } = await sb.from('customers').select('id,name,email,customer_number,customer_type,personal_number').eq('company_id', COMPANY!)
  if (error) { console.error(error.message); process.exit(1) }
  const nk = (n: string) => n.trim().toLowerCase()
  const byName = new Map<string, any[]>()
  for (const c of custs ?? []) byName.set(nk(c.name), [...(byName.get(nk(c.name)) ?? []), c])
  let ok = 0, noMatch = 0, notIndividual = 0, invalid = 0, empty = 0, already = 0, nameDiff = 0
  const updates: { id: string; pn: string }[] = []
  for (const r of rows) {
    const cands = byName.get(nk(r.name)) ?? []
    const c = cands.length === 1 ? cands[0] : cands.find(x => (x.email ?? '').toLowerCase() === r.email)
    if (!c) { noMatch++; console.log('no match', r.num, r.name); continue }
    if (!r.pn) { empty++; continue }
    if (c.customer_type !== 'individual') { notIndividual++; continue }
    if (c.personal_number) { already++; continue }
    const n = normalize(r.pn)
    if (!n) { invalid++; console.log('invalid', r.num, r.name, r.pn); continue }
    if (c.name.trim().toLowerCase() !== r.name.trim().toLowerCase()) { nameDiff++; console.log('name differs', r.num, JSON.stringify(c.name), JSON.stringify(r.name)) }
    updates.push({ id: c.id, pn: n }); ok++
  }
  console.log({ toUpdate: ok, noMatch, notIndividual, invalid, noNumberInCsv: empty, alreadySet: already, nameDiff })
  if (!APPLY) { console.log('Dry run.'); return }
  let done = 0, failed = 0
  for (const u of updates) {
    const { error: e } = await sb.from('customers').update({ personal_number: encryptCustomerPersonalNumber(u.pn) }).eq('id', u.id).eq('company_id', COMPANY!)
    if (e) { failed++; console.log('fail', u.id, e.message) } else done++
  }
  console.log({ updated: done, failed })
}
main().catch(e => { console.error(e); process.exit(1) })

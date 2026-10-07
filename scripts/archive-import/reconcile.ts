import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env' })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const C = 'cde8db5b-da1b-4b75-ad48-ce1a2d9de1c3'
async function all(table: string, sel: string, f: (q: any) => any) {
  const out: any[] = []; for (let o = 0; ; o += 1000) { const { data, error } = await f(sb.from(table).select(sel)).range(o, o + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break } return out
}
async function main() {
  const entries = await all('journal_entries', 'id,entry_date,status', q => q.eq('company_id', C).in('status', ['posted', 'reversed']))
  const date = new Map(entries.map(e => [e.id, e.entry_date as string]))
  const lines: any[] = []
  for (const acc of ['1510', '1518', '2440', '2448']) lines.push(...await all('journal_entry_lines', 'journal_entry_id,account_number,debit_amount,credit_amount', q => q.eq('account_number', acc)))
  const mine = lines.filter(l => date.has(l.journal_entry_id))
  const gl = (accs: string[], D: string, sign: 1 | -1) => Math.round(mine.filter(l => accs.includes(l.account_number) && date.get(l.journal_entry_id)! <= D).reduce((s, l) => s + sign * (l.debit_amount - l.credit_amount), 0) * 100) / 100
  const inv = await all('invoices', 'invoice_date,status,total_sek,paid_at', q => q.eq('company_id', C))
  const sinv = await all('supplier_invoices', 'invoice_date,status,total_sek,paid_at,is_credit_note', q => q.eq('company_id', C))
  const open = (rows: any[], D: string, credit?: boolean) => Math.round(rows.filter(r => r.invoice_date <= D && r.status !== 'draft' && Number(r.total_sek) > 0 && !(r.is_credit_note) && (r.status === 'paid' ? (r.paid_at && r.paid_at.slice(0, 10) > D) : !['credited', 'reversed'].includes(r.status))).reduce((s, r) => s + Number(r.total_sek ?? 0), 0) * 100) / 100
  console.log('date | GL1510 | GL1518 | OpenInv | diff | GL2440(cr) | OpenSupInv | diff')
  for (const D of ['2021-06-30', '2022-06-30', '2023-06-30', '2024-06-30', '2025-06-30', '2026-06-30', '2026-10-04']) {
    const g1 = gl(['1510'], D, 1), g18 = gl(['1518'], D, 1), oi = open(inv, D), g2 = gl(['2440', '2448'], D, -1), os = open(sinv, D, true)
    console.log(D, '|', g1, '|', g18, '|', oi, '|', Math.round((g1 + g18 - oi) * 100) / 100, '|', g2, '|', os, '|', Math.round((g2 - os) * 100) / 100)
  }
}
main().catch(e => { console.error(e); process.exit(1) })

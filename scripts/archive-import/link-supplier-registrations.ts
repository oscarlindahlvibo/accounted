import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
config({ path: '.env' })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const C = 'cde8db5b-da1b-4b75-ad48-ce1a2d9de1c3'; const APPLY = process.argv.includes('--apply')
const r2 = (n: number) => Math.round(n * 100) / 100
async function all(table: string, sel: string, f: (q: any) => any) { const out: any[] = []; for (let o = 0; ; o += 1000) { const { data, error } = await f(sb.from(table).select(sel)).range(o, o + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break } return out }
async function main() {
  const es = await all('journal_entries', 'id,description', q => q.eq('company_id', C).eq('status', 'posted').like('description', 'Leverantörsfaktura från%'))
  const ids = new Set(es.map(e => e.id)); const cr = new Map<string, number>()
  for (const l of await all('journal_entry_lines', 'journal_entry_id,debit_amount,credit_amount', q => q.eq('account_number', '2440'))) if (ids.has(l.journal_entry_id)) cr.set(l.journal_entry_id, (cr.get(l.journal_entry_id) ?? 0) + l.credit_amount - l.debit_amount)
  const sis = await all('supplier_invoices', 'id,supplier_invoice_number,total_sek,registration_journal_entry_id,suppliers(name)', q => q.eq('company_id', C))
  const by = new Map<string, any[]>(); for (const s of sis) by.set(String(s.supplier_invoice_number), [...(by.get(String(s.supplier_invoice_number)) ?? []), s])
  const used = new Set<string>(); const ups: { id: string; je: string }[] = []; let skip = 0
  for (const e of es) {
    const d: string = e.description; const i = d.lastIndexOf(', '); if (i < 0) { skip++; continue }
    const inv = d.slice(i + 2).trim(); const head = d.slice(0, i).toLowerCase()
    const c = (by.get(inv) ?? []).filter(s => !s.registration_journal_entry_id && !used.has(s.id))
    const pick = c.length === 1 ? c[0] : c.find(s => s.suppliers?.name && head.includes(String(s.suppliers.name).toLowerCase().slice(0, 12)))
    if (!pick || Math.abs(r2(cr.get(e.id) ?? 0) - Number(pick.total_sek)) > 0.5) { skip++; continue }
    used.add(pick.id); ups.push({ id: pick.id, je: e.id })
  }
  console.log({ vouchers: es.length, toLink: ups.length, skipped: skip })
  if (!APPLY) return
  let ok = 0, fail = 0
  for (const u of ups) { const { error } = await sb.from('supplier_invoices').update({ registration_journal_entry_id: u.je }).eq('id', u.id).eq('company_id', C).is('registration_journal_entry_id', null); error ? (fail++, console.log(error.message)) : ok++ }
  console.log({ linked: ok, failed: fail })
  const { count } = await sb.from('invoices').select('id', { count: 'exact', head: true }).eq('company_id', C).eq('customer_id', '4b3f525d-31e6-402c-9cad-bd35d3742884')
  if (!count) { const { error } = await sb.from('customers').delete().eq('id', '4b3f525d-31e6-402c-9cad-bd35d3742884').eq('company_id', C).eq('name', '5569146714'); console.log('stub customer removed:', !error, error?.message ?? '') } else console.log('stub customer in use, kept')
}
main()

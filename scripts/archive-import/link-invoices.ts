#!/usr/bin/env npx tsx
/**
 * Links imported invoices to their SIE-migrated verifikat from the voucher text:
 *  - "Kundfaktura till <nr> <namn>, <fakturanr>"       -> invoices.journal_entry_id (registration), if debit 1510 == total
 *  - "[Del]inbetalning från <nr> <namn>, <fakturanr>"  -> invoice_payments row (notes 'migrerad:sie-koppling'), amount = 1510 credit
 *  - "[Del]betalning till <nr> <namn>, <fakturanr>"    -> attach_supplier_invoice_settlement_voucher RPC (never changes the invoice)
 * Creates no journal entries and never edits invoice amounts/status. Dry run by default.
 * npx tsx scripts/archive-import/link-invoices.ts --company <uuid> [--apply]
 */
import { createClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { resolve } from 'node:path'
import { writeFileSync } from 'node:fs'

const arg = (f: string) => { const i = process.argv.indexOf(f); const v = process.argv[i + 1]; return i >= 0 && v && !v.startsWith('--') ? v : null }
const C = arg('--company')!; const APPLY = process.argv.includes('--apply')
dotenv({ path: resolve(process.cwd(), '.env') })
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const r2 = (n: number) => Math.round(n * 100) / 100
async function all(table: string, sel: string, f: (q: any) => any) {
  const out: any[] = []
  for (let o = 0; ; o += 1000) { const { data, error } = await f(sb.from(table).select(sel)).range(o, o + 999); if (error) throw error; out.push(...data); if (data.length < 1000) break }
  return out
}
const splitInv = (rest: string) => { const i = rest.lastIndexOf(', '); return i < 0 ? null : { head: rest.slice(0, i), inv: rest.slice(i + 2).trim() } }

async function main() {
  console.log(APPLY ? 'APPLY' : 'DRY RUN')
  const { data: own } = await sb.from('company_members').select('user_id').eq('company_id', C).eq('role', 'owner').order('created_at').limit(1)
  const userId = own![0].user_id as string
  const entries = await all('journal_entries', 'id,entry_date,description,voucher_series,voucher_number', q => q.eq('company_id', C).eq('status', 'posted'))
  const byId = new Map(entries.map(e => [e.id, e]))
  const amt = new Map<string, { ard: number; arc: number; apd: number; apc: number; cb: number }>()
  for (const acc of ['1510', '2440', '19']) {
    for (const l of await all('journal_entry_lines', 'journal_entry_id,account_number,debit_amount,credit_amount', q => acc === '19' ? q.like('account_number', '19%') : q.eq('account_number', acc))) {
      if (!byId.has(l.journal_entry_id)) continue
      const a = amt.get(l.journal_entry_id) ?? { ard: 0, arc: 0, apd: 0, apc: 0, cb: 0 }
      if (acc === '19') a.cb += l.debit_amount - l.credit_amount
      else if (acc === '1510') { a.ard += l.debit_amount; a.arc += l.credit_amount } else { a.apd += l.debit_amount; a.apc += l.credit_amount }
      amt.set(l.journal_entry_id, a)
    }
  }
  const invs = await all('invoices', 'id,invoice_number,status,total_sek,journal_entry_id', q => q.eq('company_id', C))
  const invByNo = new Map(invs.map(i => [String(i.invoice_number), i]))
  const pays = await all('invoice_payments', 'invoice_id,journal_entry_id,amount', q => q.eq('company_id', C))
  const paidSum = new Map<string, number>(); for (const p of pays) paidSum.set(p.invoice_id, (paidSum.get(p.invoice_id) ?? 0) + Number(p.amount))
  const sinvs = await all('supplier_invoices', 'id,supplier_invoice_number,status,total_sek,supplier_id,suppliers(name)', q => q.eq('company_id', C))
  const sByNo = new Map<string, any[]>(); for (const s of sinvs) sByNo.set(String(s.supplier_invoice_number), [...(sByNo.get(String(s.supplier_invoice_number)) ?? []), s])

  const st = { regLinked: 0, regSkip: 0, payRows: 0, paySkip: 0, supPay: 0, supSkip: 0, noInv: 0 }
  const issues: any[] = []; const unmatchedAP: Record<string, number> = {}
  const newPays: any[] = []; const regUpdates: { id: string; je: string }[] = []; const supCalls: { si: string; je: string }[] = []
  const usedReg = new Set<string>()
  for (const e of entries) {
    const d = (e.description ?? '').trim(); const a = amt.get(e.id)
    let m: RegExpMatchArray | null
    if ((m = d.match(/^Kundfaktura till \d+ (.+)$/i))) {
      const s = splitInv(m[1]); const inv = s && invByNo.get(s.inv)
      if (!inv) { st.noInv++; issues.push({ d, why: 'no invoice' }); continue }
      if (inv.journal_entry_id || usedReg.has(inv.id) || !a || Math.abs(r2(a.ard - a.arc) - Number(inv.total_sek)) > 0.5) { st.regSkip++; issues.push({ d, why: 'reg skip' }); continue }
      usedReg.add(inv.id); regUpdates.push({ id: inv.id, je: e.id }); st.regLinked++
    } else if ((m = d.match(/^(?:Del)?inbetalning från \d+ (.+)$/i))) {
      const s = splitInv(m[1]); const inv = s && invByNo.get(s.inv)
      if (!inv) { st.noInv++; issues.push({ d, why: 'no invoice' }); continue }
      const amount = a ? r2(a.arc - a.ard > 0 ? a.arc - a.ard : a.cb) : 0
      const tot = (paidSum.get(inv.id) ?? 0) + amount
      if (amount <= 0 || tot > Number(inv.total_sek) + 0.5) { st.paySkip++; issues.push({ d, why: `pay skip amt=${amount} tot=${tot} inv=${inv.total_sek}` }); continue }
      paidSum.set(inv.id, tot); newPays.push({ user_id: userId, company_id: C, invoice_id: inv.id, payment_date: e.entry_date, amount, journal_entry_id: e.id, notes: 'migrerad:sie-koppling' }); st.payRows++
    } else if ((m = d.match(/^(?:Del)?betalning till \d+ (.+)$/i))) {
      const s = splitInv(m[1]); const cands = s ? (sByNo.get(s.inv) ?? []) : []
      const pick = cands.length === 1 ? cands[0] : cands.find(c => c.suppliers?.name && s && s.head.toLowerCase().includes(String(c.suppliers.name).toLowerCase().slice(0, 12)))
      if (!pick) { st.noInv++; issues.push({ d, why: 'no supplier invoice' }); continue }
      supCalls.push({ si: pick.id, je: e.id }); st.supPay++
    } else if (a && a.apc - a.apd > 0) {
      const k = d.replace(/[0-9]+/g, '#').split(',')[0].slice(0, 30); unmatchedAP[k] = (unmatchedAP[k] ?? 0) + 1
    }
  }
  console.log(st); console.log('unmatched 2440-credit patterns:', Object.entries(unmatchedAP).sort((a, b) => b[1] - a[1]).slice(0, 8))
  writeFileSync('/tmp/link-issues.json', JSON.stringify(issues, null, 1))
  if (!APPLY) {
    let ok = 0; const reasons: Record<string, number> = {}
    for (const c of supCalls.slice(0, 400)) { const { data } = await sb.rpc('attach_supplier_invoice_settlement_voucher', { p_supplier_invoice_id: c.si, p_journal_entry_id: c.je, p_user_id: userId, p_company_id: C, p_dry_run: true }); if (data?.ok) ok++; else reasons[data?.code ?? 'err'] = (reasons[data?.code ?? 'err'] ?? 0) + 1 }
    console.log('supplier dry-run (first 400):', { ok, reasons }); return
  }
  for (let i = 0; i < newPays.length; i += 200) { const { error } = await sb.from('invoice_payments').insert(newPays.slice(i, i + 200)); if (error) { console.error('invoice_payments insert', error.message); break } }
  for (const u of regUpdates) await sb.from('invoices').update({ journal_entry_id: u.je }).eq('id', u.id).eq('company_id', C).is('journal_entry_id', null)
  let ok = 0; const reasons: Record<string, number> = {}
  for (const c of supCalls) { const { data } = await sb.rpc('attach_supplier_invoice_settlement_voucher', { p_supplier_invoice_id: c.si, p_journal_entry_id: c.je, p_user_id: userId, p_company_id: C }); if (data?.ok) ok++; else reasons[data?.code ?? 'err'] = (reasons[data?.code ?? 'err'] ?? 0) + 1 }
  console.log('applied:', { payRows: newPays.length, regLinked: regUpdates.length, supplierAttached: ok, supplierRejected: reasons })
}
main().catch(e => { console.error(e); process.exit(1) })

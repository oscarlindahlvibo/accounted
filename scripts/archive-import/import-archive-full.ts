#!/usr/bin/env npx tsx
/**
 * Imports customers, suppliers, sales invoices and supplier invoices from an
 * Accounted full-archive export (data/*.json) into ANOTHER company on this
 * deployment, creating the customers/suppliers too. No GL is touched:
 * journal_entry_id / registration_journal_entry_id / payment_journal_entry_id /
 * transaction_id / document_id are never copied. personal_number (encrypted
 * with the source deployment's key) is not copied.
 *
 * Dry run by default; --apply writes. Refuses to run if the company already has
 * invoices, customers or suppliers.
 *
 * npx tsx scripts/archive-import/import-archive-full.ts --company <uuid> --data <dir> [--apply]
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const arg = (f: string) => { const i = process.argv.indexOf(f); const v = process.argv[i + 1]; return i >= 0 && v && !v.startsWith('--') ? v : null }
const COMPANY = arg('--company'); const DATA = arg('--data'); const APPLY = process.argv.includes('--apply')
if (!COMPANY || !UUID_RE.test(COMPANY) || !DATA) { console.error('Usage: --company <uuid> --data <dir> [--apply]'); process.exit(1) }

dotenv({ path: resolve(process.cwd(), '.env') })
const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error('Missing supabase env'); process.exit(1) }
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as SupabaseClient

type Row = Record<string, any>
const load = (n: string): Row[] => JSON.parse(readFileSync(resolve(process.cwd(), join(DATA!, n)), 'utf8'))
const pick = (r: Row, cols: string[]) => { const o: Row = {}; for (const c of cols) if (r[c] !== undefined) o[c] = r[c]; return o }

async function insert(table: string, rows: Row[], chunk: number) {
  let ok = 0, failed = 0, firstErr: string | null = null
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk)
    const bulk = await sb.from(table).insert(part)
    if (!bulk.error) { ok += part.length; continue }
    firstErr ??= bulk.error.message
    for (const r of part) { const s = await sb.from(table).insert(r); if (s.error) { failed++; firstErr = s.error.message } else ok++ }
  }
  console.log(`  ${table}: inserted=${ok} failed=${failed}${firstErr ? ' firstError=' + firstErr : ''}`)
  return failed
}
async function count(table: string) {
  const { count: c, error } = await sb.from(table).select('id', { count: 'exact', head: true }).eq('company_id', COMPANY!)
  if (error) { console.error(error.message); process.exit(1) }
  return c ?? 0
}

const CUST = ['name','org_number','vat_number','email','phone','address_line1','address_line2','postal_code','city','country','is_international','notes','archived_at','vat_number_validated_at','customer_type','language','default_payment_terms','vat_number_validated','customer_number','contact_person','invoice_email_cc_addresses','invoice_email_bcc_addresses','country_raw']
const SUPP = ['name','supplier_type','org_number','vat_number','email','phone','address_line1','address_line2','postal_code','city','country','bankgiro','plusgiro','bank_account','iban','bic','clearing_number','account_number','default_expense_account','default_payment_terms','default_currency','category','is_active','notes','archived_at','country_raw']
const INV = ['invoice_number','invoice_date','due_date','status','currency','exchange_rate','exchange_rate_date','subtotal','subtotal_sek','vat_amount','vat_amount_sek','total','total_sek','vat_treatment','vat_rate','moms_ruta','your_reference','our_reference','notes','reverse_charge_text','paid_at','paid_amount','document_type','remaining_amount','delivery_date','received_date','ore_rounding','default_dimensions','creation_complete','invoice_marking','is_self_billed','external_invoice_number','self_billing_agreement_ref']
const ITEM = ['sort_order','description','quantity','unit','unit_price','line_total','vat_rate','vat_amount','line_type','revenue_account','discount_percent','dimensions']
const SINV = ['supplier_invoice_number','invoice_date','due_date','received_date','delivery_date','status','currency','exchange_rate','exchange_rate_date','subtotal','subtotal_sek','vat_amount','vat_amount_sek','total','total_sek','vat_treatment','reverse_charge','payment_reference','paid_at','paid_amount','remaining_amount','is_credit_note','notes','paid_with_private_funds','ore_rounding','default_dimensions','approved_at','bank_entered_at']
const SITEM = ['sort_order','description','quantity','unit','unit_price','line_total','account_number','vat_code','vat_rate','vat_amount','reverse_charge_rate','dimensions','apply_slp']

async function main() {
  console.log(APPLY ? 'APPLY' : 'DRY RUN')
  const { data: own, error: oe } = await sb.from('company_members').select('user_id').eq('company_id', COMPANY!).eq('role', 'owner').order('created_at').limit(1)
  if (oe || !own?.length) { console.error('no owner', oe?.message); process.exit(1) }
  const userId = own[0].user_id as string
  for (const t of ['invoices', 'suppliers', 'supplier_invoices']) {
    const c = await count(t); if (c > 0) { console.error(`Refusing: ${t} already has ${c} rows for this company`); process.exit(1) }
  }
  const base = { user_id: userId, company_id: COMPANY }
  const custMap = new Map<string, string>(), suppMap = new Map<string, string>()
  const customers = load('customers.json').map(c => { const id = randomUUID(); custMap.set(c.id, id); return { id, ...base, ...pick(c, CUST) } })
  const suppliers = load('suppliers.json').map(s => { const id = randomUUID(); suppMap.set(s.id, id); return { id, ...base, ...pick(s, SUPP) } })
  const invs = load('invoices.json'); const iitems = load('invoice_items.json')
  const invMap = new Map<string, string>()
  const invRows = invs.map(i => { const id = randomUUID(); invMap.set(i.id, id); return { id, ...base, customer_id: custMap.get(i.customer_id), ...pick(i, INV) } })
  const itemRows = iitems.filter(x => invMap.has(x.invoice_id)).map(x => ({ id: randomUUID(), invoice_id: invMap.get(x.invoice_id), ...pick(x, ITEM) }))
  const sis = load('supplier_invoices.json'); const sitems = load('supplier_invoice_items.json')
  const siMap = new Map<string, string>()
  let arrival = 1
  const sinvRows = sis.map(i => { const id = randomUUID(); siMap.set(i.id, id); return { id, ...base, supplier_id: suppMap.get(i.supplier_id), arrival_number: arrival++, ...pick(i, SINV) } })
  const sitemRows = sitems.filter(x => siMap.has(x.supplier_invoice_id)).map(x => ({ id: randomUUID(), supplier_invoice_id: siMap.get(x.supplier_invoice_id), ...pick(x, SITEM) }))
  const sum = (a: Row[], k: string) => Math.round(a.reduce((s, r) => s + Number(r[k] || 0), 0) * 100) / 100
  console.log(`customers=${customers.length} suppliers=${suppliers.length} invoices=${invRows.length} (sum ${sum(invRows, 'total')}) items=${itemRows.length} supplierInvoices=${sinvRows.length} (sum ${sum(sinvRows, 'total')}) items=${sitemRows.length}`)
  if (invRows.some(r => !r.customer_id) || sinvRows.some(r => !r.supplier_id)) { console.error('unmapped party'); process.exit(1) }
  if (!APPLY) { console.log('Dry run done.'); return }
  let f = 0
  f += await insert('customers', customers, 200)
  f += await insert('suppliers', suppliers, 200)
  f += await insert('invoices', invRows, 200)
  f += await insert('invoice_items', itemRows, 300)
  f += await insert('supplier_invoices', sinvRows, 200)
  f += await insert('supplier_invoice_items', sitemRows, 300)
  console.log(f ? `DONE with ${f} failed rows` : 'DONE')
}
main().catch(e => { console.error(e); process.exit(1) })

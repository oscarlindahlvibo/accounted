#!/usr/bin/env npx tsx
/**
 * One-shot: import sales invoices, suppliers and supplier invoices from an
 * Accounted "full archive export" (data/*.json) into a DIFFERENT company in
 * this same deployment.
 *
 * WHY: a customer's real invoice/supplier history was migrated once, via the
 * Visma/Spiris wizard, into a throwaway test company. The rows there are
 * already correct Accounted rows (real invoice numbers, VAT split, payment
 * status) - this script copies them into the real company, remapping only
 * the foreign keys (customer_id, supplier_id, company_id, user_id) and
 * dropping anything that points at the SOURCE company (journal_entry_id,
 * document_id, transaction_id): the real company's general ledger already
 * exists from a separate SIE import, and this script must never create or
 * touch a journal_entries row. No GL postings are made.
 *
 * Customers are NOT created here: they were already created in the target
 * company by hand (see --customer-map). Suppliers ARE created here, since
 * none existed yet for the target company.
 *
 * Credit notes: the source row's credited_invoice_id/is_credit_note is kept
 * data-only; a same-run credited_invoice_id is relinked to the NEW id after
 * insert. A credited_invoice_id pointing outside this run's invoice set is
 * dropped (logged), never guessed.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write. Always run the dry run first
 * and read its counts.
 *
 * Usage:
 *   npx tsx scripts/archive-import/import-archive.ts \
 *     --company <target-company-uuid> \
 *     --data scripts/archive-import/data \
 *     --customer-map scripts/archive-import/data/customer_id_map_full.json \
 *     --skip-invoice-number 1397 \
 *     [--only suppliers|invoices|supplier-invoices] \
 *     [--delete-draft-invoices] \
 *     [--apply]
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local,
 * same as every other script in scripts/migration. That file points at
 * PRODUCTION on this deployment: read the dry-run counts before --apply.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  const value = process.argv[i + 1]
  return i >= 0 && value && !value.startsWith('--') ? value : null
}
function argValues(flag: string): string[] {
  const out: string[] = []
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) out.push(process.argv[i + 1])
  }
  return out
}

const USAGE =
  'Usage: npx tsx scripts/archive-import/import-archive.ts --company <uuid> --data <dir> --customer-map <file> [--only suppliers|invoices|supplier-invoices] [--skip-invoice-number N]... [--delete-draft-invoices] [--apply]'

const COMPANY_ID = argValue('--company')?.trim() ?? null
const DATA_DIR = argValue('--data')?.trim() ?? null
const CUSTOMER_MAP_FILE = argValue('--customer-map')?.trim() ?? null
const ONLY = argValue('--only')?.trim() ?? null
const SKIP_NUMBERS = new Set(argValues('--skip-invoice-number'))
const DELETE_DRAFTS = process.argv.includes('--delete-draft-invoices')
const APPLY = process.argv.includes('--apply')

if (!COMPANY_ID || !UUID_RE.test(COMPANY_ID)) {
  console.error('--company <uuid> is required.')
  console.error(USAGE)
  process.exit(1)
}
if (!DATA_DIR) {
  console.error('--data <dir> is required (directory with invoices.json, invoice_items.json, suppliers.json, supplier_invoices.json, supplier_invoice_items.json).')
  console.error(USAGE)
  process.exit(1)
}
if (ONLY && !['suppliers', 'invoices', 'supplier-invoices', 'none'].includes(ONLY)) {
  console.error(`--only must be suppliers, invoices or supplier-invoices, got: ${ONLY}`)
  process.exit(1)
}

function readJson<T>(name: string): T {
  const p = resolve(process.cwd(), join(DATA_DIR as string, name))
  if (!existsSync(p)) {
    console.error(`Missing required file: ${p}`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(p, 'utf8')) as T
}

dotenv({ path: resolve(process.cwd(), '.env') })
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as SupabaseClient

// ── small insert helper (same shape as extensions/general/arcim-migration/lib/insert-fallback.ts) ──
async function insertWithFallback(
  table: string,
  rows: Record<string, unknown>[],
): Promise<{ inserted: number; failedCount: number; firstError: string | null }> {
  if (rows.length === 0) return { inserted: 0, failedCount: 0, firstError: null }
  const bulk = await supabase.from(table).insert(rows)
  if (!bulk.error) return { inserted: rows.length, failedCount: 0, firstError: null }
  let inserted = 0
  let failedCount = 0
  let firstError: string | null = bulk.error.message
  for (const row of rows) {
    const single = await supabase.from(table).insert(row)
    if (single.error) {
      failedCount++
      continue
    }
    inserted++
  }
  return { inserted, failedCount, firstError }
}

async function resolveActingUser(): Promise<string> {
  const { data, error } = await supabase
    .from('company_members')
    .select('user_id, created_at')
    .eq('company_id', COMPANY_ID as string)
    .eq('role', 'owner')
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) {
    console.error(`Could not read company_members: ${error.message}`)
    process.exit(1)
  }
  if (!data || data.length === 0) {
    console.error(`No owner found for company ${COMPANY_ID}.`)
    process.exit(1)
  }
  return data[0].user_id as string
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

// ── types for the archive's native rows (subset of columns we use) ──
interface SrcCustomer { id: string; name: string }
interface SrcSupplier {
  id: string; name: string; supplier_type: string | null; org_number: string | null
  vat_number: string | null; email: string | null; phone: string | null
  address_line1: string | null; address_line2: string | null; postal_code: string | null
  city: string | null; country: string | null; bankgiro: string | null; plusgiro: string | null
  bank_account: string | null; iban: string | null; bic: string | null
  default_payment_terms: number | null; default_currency: string | null; notes: string | null
}
interface SrcInvoice {
  id: string; customer_id: string; invoice_number: string | null; invoice_date: string
  due_date: string; status: string; currency: string; subtotal: number; subtotal_sek: number
  vat_amount: number; vat_amount_sek: number; total: number; total_sek: number
  vat_treatment: string | null; vat_rate: number | null; your_reference: string | null
  our_reference: string | null; notes: string | null; credited_invoice_id: string | null
  paid_at: string | null; paid_amount: number | null; document_type: string
  remaining_amount: number | null; moms_ruta: string | null
}
interface SrcInvoiceItem {
  id: string; invoice_id: string; sort_order: number; description: string; quantity: number
  unit: string; unit_price: number; line_total: number; vat_rate: number; vat_amount: number
  line_type: string
}
interface SrcSupplierInvoice {
  id: string; supplier_id: string; supplier_invoice_number: string; invoice_date: string
  due_date: string; received_date: string | null; status: string; currency: string
  subtotal: number; vat_amount: number; total: number; vat_treatment: string | null
  reverse_charge: boolean | null; payment_reference: string | null; paid_at: string | null
  paid_amount: number | null; remaining_amount: number | null; is_credit_note: boolean
  credited_invoice_id: string | null; notes: string | null
}
interface SrcSupplierInvoiceItem {
  id: string; supplier_invoice_id: string; sort_order: number; description: string
  quantity: number; unit: string; unit_price: number; line_total: number
  account_number: string; vat_rate: number; vat_amount: number
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`)
  const userId = await resolveActingUser()
  console.log(`Acting user: ${userId}`)

  const customerMapRaw: Record<string, string> = CUSTOMER_MAP_FILE
    ? JSON.parse(readFileSync(resolve(process.cwd(), CUSTOMER_MAP_FILE), 'utf8'))
    : {}
  const customerMap: Record<string, string> = {}
  for (const [k, v] of Object.entries(customerMapRaw)) customerMap[k.trim()] = v

  // ── 1. Suppliers ──
  const supplierIdMap = new Map<string, string>()
  if (!ONLY || ONLY === 'suppliers') {
    const suppliers = readJson<SrcSupplier[]>('suppliers.json')
    const rows: Record<string, unknown>[] = []
    for (const s of suppliers) {
      const newId = randomUUID()
      supplierIdMap.set(s.id, newId)
      rows.push({
        id: newId,
        user_id: userId,
        company_id: COMPANY_ID,
        name: s.name,
        supplier_type: s.supplier_type || 'swedish_business',
        org_number: s.org_number || null,
        vat_number: s.vat_number || null,
        email: s.email || null,
        phone: s.phone || null,
        address_line1: s.address_line1 || null,
        address_line2: s.address_line2 || null,
        postal_code: s.postal_code || null,
        city: s.city || null,
        country: s.country || 'SE',
        bankgiro: s.bankgiro || null,
        plusgiro: s.plusgiro || null,
        bank_account: s.bank_account || null,
        iban: s.iban || null,
        bic: s.bic || null,
        default_payment_terms: s.default_payment_terms || 30,
        default_currency: s.default_currency || 'SEK',
        notes: s.notes || null,
      })
    }
    console.log(`Suppliers: ${rows.length} to create.`)
    if (APPLY) {
      const res = await insertWithFallback('suppliers', rows)
      console.log(`  inserted=${res.inserted} failed=${res.failedCount} firstError=${res.firstError ?? '-'}`)
    }
  }

  // ── 2. Delete junk draft invoices (never sent, zero GL impact) ──
  if (DELETE_DRAFTS) {
    const { data: drafts, error } = await supabase
      .from('invoices')
      .select('id')
      .eq('company_id', COMPANY_ID as string)
      .eq('status', 'draft')
      .is('invoice_number', null)
    if (error) {
      console.error(`Could not read draft invoices: ${error.message}`)
      process.exit(1)
    }
    console.log(`Draft invoices with no number (to delete): ${drafts?.length ?? 0}`)
    if (APPLY && drafts && drafts.length > 0) {
      const ids = drafts.map((d) => d.id as string)
      let deleted = 0
      for (let i = 0; i < ids.length; i += 40) {
        const chunk = ids.slice(i, i + 40)
        const { error: delErr, count } = await supabase
          .from('invoices')
          .delete({ count: 'exact' })
          .in('id', chunk)
        if (delErr) {
          console.error(`  chunk[${i}..${i + chunk.length}) delete failed: ${delErr.message}`)
        } else {
          deleted += count ?? 0
        }
      }
      console.log(`  deleted=${deleted}`)
    }
  }

  // ── 3. Sales invoices ──
  if (!ONLY || ONLY === 'invoices') {
    const customers = readJson<SrcCustomer[]>('customers.json')
    const customerNameById = new Map(customers.map((c) => [c.id, (c.name || '').trim()]))
    const invoices = readJson<SrcInvoice[]>('invoices.json')
    const items = readJson<SrcInvoiceItem[]>('invoice_items.json')
    const itemsByInvoice = new Map<string, SrcInvoiceItem[]>()
    for (const it of items) {
      const arr = itemsByInvoice.get(it.invoice_id) ?? []
      arr.push(it)
      itemsByInvoice.set(it.invoice_id, arr)
    }

    // existing invoice_numbers in target, to refuse a collision instead of erroring blind
    const { data: existingRows, error: existErr } = await supabase
      .from('invoices')
      .select('invoice_number')
      .eq('company_id', COMPANY_ID as string)
      .not('invoice_number', 'is', null)
    if (existErr) {
      console.error(`Could not read existing invoice_numbers: ${existErr.message}`)
      process.exit(1)
    }
    const existingNumbers = new Set((existingRows ?? []).map((r) => r.invoice_number as string))

    const idMap = new Map<string, string>() // source invoice id -> new id
    const invoiceRows: Record<string, unknown>[] = []
    const itemRows: Record<string, unknown>[] = []
    const pendingCredits: { newId: string; sourceCreditedId: string }[] = []
    let skippedPilot = 0
    let skippedNoCustomer = 0
    let skippedCollision = 0
    let sumTotal = 0

    for (const inv of invoices) {
      if (inv.invoice_number && SKIP_NUMBERS.has(inv.invoice_number)) {
        skippedPilot++
        continue
      }
      const customerName = customerNameById.get(inv.customer_id)
      const targetCustomerId = customerName ? customerMap[customerName] : undefined
      if (!targetCustomerId) {
        skippedNoCustomer++
        console.warn(`  SKIP invoice ${inv.invoice_number ?? inv.id}: no target customer for "${customerName ?? inv.customer_id}"`)
        continue
      }
      if (inv.invoice_number && existingNumbers.has(inv.invoice_number)) {
        skippedCollision++
        console.warn(`  SKIP invoice ${inv.invoice_number}: already exists in target company`)
        continue
      }

      const newId = randomUUID()
      idMap.set(inv.id, newId)
      sumTotal += Number(inv.total) || 0

      invoiceRows.push({
        id: newId,
        user_id: userId,
        company_id: COMPANY_ID,
        customer_id: targetCustomerId,
        invoice_number: inv.invoice_number || null,
        invoice_date: inv.invoice_date,
        due_date: inv.due_date,
        status: inv.status,
        currency: inv.currency || 'SEK',
        subtotal: inv.subtotal,
        subtotal_sek: inv.subtotal_sek ?? inv.subtotal,
        vat_amount: inv.vat_amount,
        vat_amount_sek: inv.vat_amount_sek ?? inv.vat_amount,
        total: inv.total,
        total_sek: inv.total_sek ?? inv.total,
        vat_treatment: inv.vat_treatment || 'standard_25',
        vat_rate: inv.vat_rate,
        your_reference: inv.your_reference || null,
        our_reference: inv.our_reference || null,
        notes: inv.notes || null,
        document_type: 'invoice',
        paid_at: inv.paid_at || null,
        paid_amount: inv.paid_amount ?? 0,
        remaining_amount: inv.remaining_amount ?? 0,
        moms_ruta: inv.moms_ruta || null,
        // journal_entry_id intentionally omitted (null): no GL touch.
      })
      if (inv.credited_invoice_id) {
        pendingCredits.push({ newId, sourceCreditedId: inv.credited_invoice_id })
      }

      for (const it of itemsByInvoice.get(inv.id) ?? []) {
        itemRows.push({
          id: randomUUID(),
          invoice_id: newId,
          sort_order: it.sort_order,
          description: it.description,
          quantity: it.quantity,
          unit: it.unit || 'st',
          unit_price: it.unit_price,
          line_total: it.line_total,
          vat_rate: it.vat_rate,
          vat_amount: it.vat_amount,
          line_type: it.line_type || 'product',
        })
      }
    }

    console.log(`Sales invoices: ${invoiceRows.length} to create (skipped: pilot=${skippedPilot}, no-customer=${skippedNoCustomer}, collision=${skippedCollision})`)
    console.log(`  sum(total) = ${round2(sumTotal)} SEK, items = ${itemRows.length}`)
    console.log(`  credit-note links to resolve after insert: ${pendingCredits.length}`)

    if (APPLY) {
      // chunks of 200 to keep each statement reasonable
      for (let i = 0; i < invoiceRows.length; i += 200) {
        const chunk = invoiceRows.slice(i, i + 200)
        const res = await insertWithFallback('invoices', chunk)
        console.log(`  invoices[${i}..${i + chunk.length}) inserted=${res.inserted} failed=${res.failedCount} firstError=${res.firstError ?? '-'}`)
      }
      for (let i = 0; i < itemRows.length; i += 500) {
        const chunk = itemRows.slice(i, i + 500)
        const res = await insertWithFallback('invoice_items', chunk)
        console.log(`  invoice_items[${i}..${i + chunk.length}) inserted=${res.inserted} failed=${res.failedCount} firstError=${res.firstError ?? '-'}`)
      }
      let linked = 0
      let unresolved = 0
      for (const pc of pendingCredits) {
        const target = idMap.get(pc.sourceCreditedId)
        if (!target) {
          unresolved++
          continue
        }
        const { error } = await supabase.from('invoices').update({ credited_invoice_id: target }).eq('id', pc.newId)
        if (!error) linked++
      }
      console.log(`  credit-note links: linked=${linked} unresolved=${unresolved}`)
    }
  }

  // ── 4. Supplier invoices ──
  if (!ONLY || ONLY === 'supplier-invoices') {
    if (supplierIdMap.size === 0 && (ONLY === 'supplier-invoices')) {
      console.error('Running --only supplier-invoices requires suppliers to already exist from a prior --only suppliers --apply run; this process does not have the id map. Re-run including the suppliers step, or extend this script to read back supplier ids by org_number.')
      process.exit(1)
    }
    const supInvoices = readJson<SrcSupplierInvoice[]>('supplier_invoices.json')
    const supItems = readJson<SrcSupplierInvoiceItem[]>('supplier_invoice_items.json')
    const itemsByInvoice = new Map<string, SrcSupplierInvoiceItem[]>()
    for (const it of supItems) {
      const arr = itemsByInvoice.get(it.supplier_invoice_id) ?? []
      arr.push(it)
      itemsByInvoice.set(it.supplier_invoice_id, arr)
    }

    const { data: maxRow, error: maxErr } = await supabase
      .from('supplier_invoices')
      .select('arrival_number')
      .eq('company_id', COMPANY_ID as string)
      .order('arrival_number', { ascending: false })
      .limit(1)
    if (maxErr) {
      console.error(`Could not read max arrival_number: ${maxErr.message}`)
      process.exit(1)
    }
    let nextArrival = ((maxRow?.[0]?.arrival_number as number) ?? 0) + 1

    const idMap = new Map<string, string>()
    const invoiceRows: Record<string, unknown>[] = []
    const itemRows: Record<string, unknown>[] = []
    const pendingCredits: { newId: string; sourceCreditedId: string }[] = []
    let skippedNoSupplier = 0
    let sumTotal = 0

    for (const inv of supInvoices) {
      const targetSupplierId = supplierIdMap.get(inv.supplier_id)
      if (!targetSupplierId) {
        skippedNoSupplier++
        continue
      }
      const newId = randomUUID()
      idMap.set(inv.id, newId)
      sumTotal += Number(inv.total) || 0
      invoiceRows.push({
        id: newId,
        user_id: userId,
        company_id: COMPANY_ID,
        supplier_id: targetSupplierId,
        arrival_number: nextArrival++,
        supplier_invoice_number: inv.supplier_invoice_number,
        invoice_date: inv.invoice_date,
        due_date: inv.due_date,
        received_date: inv.received_date || inv.invoice_date,
        status: inv.status,
        currency: inv.currency || 'SEK',
        subtotal: inv.subtotal,
        vat_amount: inv.vat_amount,
        total: inv.total,
        vat_treatment: inv.vat_treatment || 'standard_25',
        reverse_charge: !!inv.reverse_charge,
        payment_reference: inv.payment_reference || null,
        paid_at: inv.paid_at || null,
        paid_amount: inv.paid_amount ?? 0,
        remaining_amount: inv.remaining_amount ?? 0,
        is_credit_note: !!inv.is_credit_note,
        notes: inv.notes || null,
        // registration_journal_entry_id / payment_journal_entry_id / transaction_id /
        // document_id intentionally omitted (null): no GL touch, no fake underlag link.
      })
      if (inv.credited_invoice_id) {
        pendingCredits.push({ newId, sourceCreditedId: inv.credited_invoice_id })
      }
      for (const it of itemsByInvoice.get(inv.id) ?? []) {
        itemRows.push({
          id: randomUUID(),
          supplier_invoice_id: newId,
          sort_order: it.sort_order,
          description: it.description,
          quantity: it.quantity,
          unit: it.unit || 'st',
          unit_price: it.unit_price,
          line_total: it.line_total,
          account_number: it.account_number || '4000',
          vat_rate: it.vat_rate,
          vat_amount: it.vat_amount,
        })
      }
    }

    console.log(`Supplier invoices: ${invoiceRows.length} to create (skipped no-supplier=${skippedNoSupplier})`)
    console.log(`  sum(total) = ${round2(sumTotal)} SEK, items = ${itemRows.length}`)
    console.log(`  credit-note links to resolve after insert: ${pendingCredits.length}`)

    if (APPLY) {
      for (let i = 0; i < invoiceRows.length; i += 200) {
        const chunk = invoiceRows.slice(i, i + 200)
        const res = await insertWithFallback('supplier_invoices', chunk)
        console.log(`  supplier_invoices[${i}..${i + chunk.length}) inserted=${res.inserted} failed=${res.failedCount} firstError=${res.firstError ?? '-'}`)
      }
      for (let i = 0; i < itemRows.length; i += 500) {
        const chunk = itemRows.slice(i, i + 500)
        const res = await insertWithFallback('supplier_invoice_items', chunk)
        console.log(`  supplier_invoice_items[${i}..${i + chunk.length}) inserted=${res.inserted} failed=${res.failedCount} firstError=${res.firstError ?? '-'}`)
      }
      let linked = 0
      let unresolved = 0
      for (const pc of pendingCredits) {
        const target = idMap.get(pc.sourceCreditedId)
        if (!target) {
          unresolved++
          continue
        }
        const { error } = await supabase.from('supplier_invoices').update({ credited_invoice_id: target }).eq('id', pc.newId)
        if (!error) linked++
      }
      console.log(`  credit-note links: linked=${linked} unresolved=${unresolved}`)
    }
  }

  console.log(APPLY ? 'Done (applied).' : 'Done (dry run - nothing written). Re-run with --apply to write.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

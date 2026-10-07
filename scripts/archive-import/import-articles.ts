#!/usr/bin/env npx tsx
/**
 * One-shot: import an article/price-list catalog from a Spiris
 * "Articles_Export" CSV (semicolon-delimited, Swedish decimal comma) into one
 * company's articles table.
 *
 * Column mapping (source -> articles):
 *   Number              -> article_number
 *   Name                -> name
 *   NameEnglish          -> name_en (null if empty)
 *   NetPrice             -> price_excl_vat
 *   PurchasePrice        -> cost_price (null if 0 and no purchase data at all - kept as 0 otherwise, harmless default)
 *   IsActive             -> active
 *   Unit                 -> unit, mapped PCE->st, MTR->m, DAY->dag, HUR->tim, MON->man, TNE->ton, MTQ->m3, PA->st
 *   ArticleAccountCoding -> type: '110' (goods revenue) => 'vara', everything else => 'tjanst'
 *                        -> vat_rate: '80' (momsfri/vehicle) => 0, else 25 (no 6%/12% codes present in this
 *                           source; the CSV carries no explicit VAT field, so this is the best signal available)
 *   HouseWorkType        -> NOT imported: the numeric ROT/RUT category code in this export does not map
 *                           cleanly to Accounted's housework_type values, and a wrong ROT/RUT category
 *                           would misstate a tax deduction, so it is left null rather than guessed.
 *   revenue_account       -> left null: the source coding is Spiris's own lookup, not a BAS account number.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write.
 *
 * Usage:
 *   npx tsx scripts/archive-import/import-articles.ts --company <uuid> --csv <path> [--apply]
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag)
  const value = process.argv[i + 1]
  return i >= 0 && value && !value.startsWith('--') ? value : null
}

const COMPANY_ID = argValue('--company')?.trim() ?? null
const CSV_PATH = argValue('--csv')?.trim() ?? null
const APPLY = process.argv.includes('--apply')

if (!COMPANY_ID || !UUID_RE.test(COMPANY_ID)) {
  console.error('--company <uuid> is required.')
  process.exit(1)
}
if (!CSV_PATH) {
  console.error('--csv <path> is required.')
  process.exit(1)
}

dotenv({ path: resolve(process.cwd(), '.env') })
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
}) as SupabaseClient

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

const UNIT_MAP: Record<string, string> = {
  PCE: 'st',
  MTR: 'm',
  DAY: 'dag',
  HUR: 'tim',
  MON: 'man',
  TNE: 'ton',
  MTQ: 'm3',
  PA: 'st',
}

function parseSwedishNumber(s: string): number {
  if (!s) return 0
  return parseFloat(s.replace(/\s/g, '').replace(',', '.')) || 0
}

interface Row {
  IsActive: string
  Number: string
  Name: string
  NameEnglish: string
  Notes: string
  Barcode: string
  ArticleAccountCoding: string
  Unit: string
  NetPrice: string
  PurchasePrice: string
  HouseWorkType: string
  StockBalance: string
}

function parseCsv(text: string): Row[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim().length > 0)
  const header = lines[0].split(';')
  const rows: Row[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(';')
    const row = {} as Row
    header.forEach((h, idx) => {
      (row as unknown as Record<string, string>)[h.trim()] = (cols[idx] ?? '').trim()
    })
    rows.push(row)
  }
  return rows
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`)
  const userId = await resolveActingUser()
  console.log(`Acting user: ${userId}`)

  const csvText = readFileSync(resolve(process.cwd(), CSV_PATH as string), 'utf8')
  const rows = parseCsv(csvText)
  console.log(`Parsed ${rows.length} rows from CSV.`)

  const { data: existing, error: existErr } = await supabase
    .from('articles')
    .select('article_number')
    .eq('company_id', COMPANY_ID as string)
    .not('article_number', 'is', null)
  if (existErr) {
    console.error(`Could not read existing articles: ${existErr.message}`)
    process.exit(1)
  }
  const existingNumbers = new Set((existing ?? []).map((r) => r.article_number as string))

  const toInsert: Record<string, unknown>[] = []
  let skippedCollision = 0
  let skippedEmpty = 0

  for (const r of rows) {
    if (!r.Number || !r.Name) {
      skippedEmpty++
      continue
    }
    if (existingNumbers.has(r.Number)) {
      skippedCollision++
      continue
    }
    const type = r.ArticleAccountCoding === '110' ? 'vara' : 'tjanst'
    const vatRate = r.ArticleAccountCoding === '80' ? 0 : 25
    const unit = UNIT_MAP[r.Unit] || 'st'
    toInsert.push({
      id: randomUUID(),
      company_id: COMPANY_ID,
      user_id: userId,
      article_number: r.Number,
      name: r.Name,
      name_en: r.NameEnglish || null,
      type,
      unit,
      price_excl_vat: parseSwedishNumber(r.NetPrice),
      vat_rate: vatRate,
      cost_price: parseSwedishNumber(r.PurchasePrice),
      ean: r.Barcode || null,
      notes: r.Notes || null,
      active: r.IsActive.trim().toLowerCase() === 'true',
      currency: 'SEK',
    })
  }

  console.log(`Articles to create: ${toInsert.length} (skipped: collision=${skippedCollision}, empty=${skippedEmpty})`)
  const varaCount = toInsert.filter((a) => a.type === 'vara').length
  console.log(`  type breakdown: vara=${varaCount} tjanst=${toInsert.length - varaCount}`)
  console.log('  Note: housework_type (ROT/RUT category) and revenue_account are left blank for every row - see script header.')

  if (APPLY && toInsert.length > 0) {
    const { error } = await supabase.from('articles').insert(toInsert)
    if (error) {
      console.error(`Insert failed: ${error.message}`)
      process.exit(1)
    }
    console.log(`Inserted ${toInsert.length} articles.`)
  }

  console.log(APPLY ? 'Done (applied).' : 'Done (dry run - nothing written). Re-run with --apply to write.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

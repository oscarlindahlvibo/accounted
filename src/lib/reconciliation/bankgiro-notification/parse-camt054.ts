/**
 * ISO 20022 camt.054.001.02 (BankToCustomerDebitCreditNotification) parser.
 *
 * Swedish banks (observed: Swedbank) issue this as the Bankgiro
 * "Återredovisning" — a per-Ntry breakdown of a lump bank movement into its
 * underlying Bankgiro payments, each carrying its own counterparty name and
 * structured invoice reference (`RmtInf/Strd/RfrdDocInf/Nb`). One `<Ntry>` is
 * the lump amount already visible as a single row on the bank feed; its
 * `<NtryDtls><TxDtls>` children are the sub-payments that explain it.
 *
 * Deliberately NOT reusing camt053Format (src/lib/import/bank-file/formats/
 * camt053.ts): that parser's output (`ParsedBankTransaction`, one flat row
 * per `<Ntry>`) has no room for the 1-lump-many-subpayments shape this file
 * needs. Same hand-rolled extraction style (no XML dependency) for
 * consistency with that parser.
 */

export interface ParsedCamt054SubPayment {
  amount: number
  /** Cdtr/Nm (DBIT entry) or Dbtr/Nm (CRDT entry) — the sub-payment's counterparty. */
  counterpartyName: string | null
  /** RmtInf/Strd/RfrdDocInf/Nb — the invoice/OCR reference, unstructured remittance ignored. */
  reference: string | null
  /** Refs/AcctSvcrRef, unique per sub-payment. */
  subAcctSvcrRef: string | null
}

export interface ParsedCamt054Entry {
  /** DBIT = money out (a supplier/leverantör batch payment); CRDT = money in (customer payments). */
  direction: 'DBIT' | 'CRDT'
  /** Always positive; `direction` carries the sign. */
  amount: number
  bookingDate: string // YYYY-MM-DD
  /** Ntry/AcctSvcrRef — identifies the lump entry itself, used for de-duplicating re-uploads. */
  acctSvcrRef: string | null
  subPayments: ParsedCamt054SubPayment[]
}

export interface ParsedCamt054Issue {
  message: string
  severity: 'warning' | 'error'
}

export interface ParsedCamt054Notification {
  entries: ParsedCamt054Entry[]
  issues: ParsedCamt054Issue[]
}

export function detectCamt054(content: string, filename: string): boolean {
  if (!filename.toLowerCase().endsWith('.xml')) return false
  const lower = content.toLowerCase()
  return lower.includes('camt.054') || lower.includes('bktocstmrdbtcdtntfctn')
}

export function parseCamt054(content: string): ParsedCamt054Notification {
  const issues: ParsedCamt054Issue[] = []
  const entries: ParsedCamt054Entry[] = []

  const notifications = extractElements(content, 'Ntfctn')
  if (notifications.length === 0) {
    issues.push({ message: 'Ingen <Ntfctn> hittades i filen.', severity: 'error' })
    return { entries, issues }
  }

  for (const ntfctn of notifications) {
    const ntries = extractElements(ntfctn, 'Ntry')
    for (let i = 0; i < ntries.length; i++) {
      const ntry = ntries[i]
      try {
        const entry = parseEntry(ntry)
        if (entry) entries.push(entry)
        else issues.push({ message: `Post ${i + 1}: kunde inte tolkas (saknar belopp, datum eller riktning).`, severity: 'warning' })
      } catch (err) {
        issues.push({
          message: `Post ${i + 1}: fel vid tolkning (${err instanceof Error ? err.message : 'okänt fel'}).`,
          severity: 'warning',
        })
      }
    }
  }

  return { entries, issues }
}

function parseEntry(ntry: string): ParsedCamt054Entry | null {
  const amountStr = extractTextContent(ntry, 'Amt')
  const direction = extractTextContent(ntry, 'CdtDbtInd')
  const bookingDate = extractNestedText(ntry, 'BookgDt', 'Dt')
  const acctSvcrRef = extractTextContent(ntry, 'AcctSvcrRef')

  if (!amountStr || (direction !== 'DBIT' && direction !== 'CRDT') || !bookingDate) return null
  const amount = Math.abs(Math.round(parseFloat(amountStr) * 100) / 100)
  if (isNaN(amount)) return null

  const subPayments: ParsedCamt054SubPayment[] = []
  // Each Bankgiro payment lives in its own <NtryDtls><TxDtls>; a Ntry may
  // carry several <NtryDtls> siblings (observed) or several <TxDtls> nested
  // under one <NtryDtls> (spec-permitted) — walk both. Within ONE <TxDtls>,
  // a payer can in turn settle several references in one transfer (a tenant
  // paying two months' hyresavier together): each is its own <RmtInf><Strd>
  // with its own RfrdDocAmt, so one TxDtls can explode into several
  // sub-payments (see parseSubPayments).
  for (const ntryDtls of extractElements(ntry, 'NtryDtls')) {
    for (const txDtls of extractElements(ntryDtls, 'TxDtls')) {
      subPayments.push(...parseSubPayments(txDtls, direction))
    }
  }

  return { direction, amount, bookingDate, acctSvcrRef, subPayments }
}

function parseSubPayments(txDtls: string, direction: 'DBIT' | 'CRDT'): ParsedCamt054SubPayment[] {
  // DBIT entry: money left our account, the counterparty is the creditor
  // (Cdtr) it went to. CRDT entry: money arrived, the counterparty is the
  // debtor (Dbtr) it came from. Shared by every Strd within this TxDtls.
  const counterpartyRaw =
    direction === 'DBIT'
      ? extractNestedText(txDtls, 'Cdtr', 'Nm')
      : extractNestedText(txDtls, 'Dbtr', 'Nm')
  const counterpartyName = counterpartyRaw ? unescapeXml(counterpartyRaw) : null
  const subAcctSvcrRef = extractNestedText(txDtls, 'Refs', 'AcctSvcrRef')

  const rmtInf = extractNestedElement(txDtls, 'RmtInf')
  const strdBlocks = rmtInf ? extractElements(rmtInf, 'Strd') : []

  if (strdBlocks.length === 0) {
    // No structured remittance at all: one sub-payment for the whole
    // TxDtls amount, with nothing to match a reference against.
    const amountStr = extractNestedText(txDtls, 'AmtDtls', 'Amt') ?? extractTextContent(txDtls, 'Amt')
    const amount = amountStr ? Math.abs(Math.round(parseFloat(amountStr) * 100) / 100) : 0
    return [{ amount, counterpartyName, reference: null, subAcctSvcrRef }]
  }

  return strdBlocks.map((strd) => {
    const amountStr = extractNestedText(strd, 'RfrdDocAmt', 'RmtdAmt')
    const amount = amountStr ? Math.abs(Math.round(parseFloat(amountStr) * 100) / 100) : 0
    // The structured reference (RfrdDocInf/Nb) is the primary, machine-issued
    // reference when present. Several real Bankgiro payers (hyresavier from
    // a property-management portal, observed) leave it empty and put the
    // actual invoice/tenant reference in the free-text AddtlRmtInf instead;
    // the matcher's own digit-length floor (ocr-keys.ts) rejects anything
    // too short or non-numeric to be trustworthy, so falling back here adds
    // recall without weakening the match.
    const reference = extractNestedText(strd, 'RfrdDocInf', 'Nb') ?? extractTextContent(strd, 'AddtlRmtInf')
    return { amount, counterpartyName, reference, subAcctSvcrRef }
  })
}

// ---- shared hand-rolled XML helpers (same approach as camt053.ts) ----

function extractElements(xml: string, tagName: string): string[] {
  const elements: string[] = []
  const regex = new RegExp(`<${tagName}(?=[\\s>/])`, 'gi')
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) {
    const startIdx = match.index
    const closeTag = `</${tagName}>`
    const closeIdx = xml.indexOf(closeTag, startIdx + match[0].length)
    if (closeIdx === -1) continue
    elements.push(xml.substring(startIdx, closeIdx + closeTag.length))
    regex.lastIndex = closeIdx + closeTag.length
  }
  return elements
}

function extractTextContent(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([^<]+)<`, 'i')
  const match = xml.match(regex)
  return match?.[1]?.trim() || null
}

function extractNestedText(xml: string, parentTag: string, childTag: string): string | null {
  const parent = extractNestedElement(xml, parentTag)
  if (!parent) return null
  const childRegex = new RegExp(`<${childTag}[^>]*>([^<]+)<`, 'i')
  const childMatch = parent.match(childRegex)
  return childMatch?.[1]?.trim() || null
}

/** Inner XML of the first occurrence of a tag (not just its flat text content). */
function extractNestedElement(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i')
  return xml.match(regex)?.[1] ?? null
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

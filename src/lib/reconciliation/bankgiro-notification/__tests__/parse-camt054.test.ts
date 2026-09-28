import { describe, it, expect } from 'vitest'
import { parseCamt054, detectCamt054 } from '../parse-camt054'

// Real Swedbank Bankgiro "Återredovisning" (camt.054.001.02) exports, trimmed
// to the structurally relevant elements. The 2026-06-30 file is the only one
// of the three real samples that actually bundles more than one payment
// under a single Ntry (2493 + 831 = 3324, two <NtryDtls> siblings) — the
// shape this whole feature exists to split automatically.
const TWO_SUBPAYMENT_LUMP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02">
<BkToCstmrDbtCdtNtfctn>
<GrpHdr><MsgId>SWEDSESSDEBT202606300039974812</MsgId><CreDtTm>2026-06-30T13:25:21.835742</CreDtTm></GrpHdr>
<Ntfctn>
<Id>SWEDSESSDEBT20260630003997481200001</Id>
<Acct><Id><Othr><Id>840533338800950</Id></Othr></Id><Ccy>SEK</Ccy></Acct>
<Ntry>
<Amt Ccy="SEK">3324.00</Amt>
<CdtDbtInd>DBIT</CdtDbtInd>
<Sts>BOOK</Sts>
<BookgDt><Dt>2026-06-30</Dt></BookgDt>
<AcctSvcrRef>2026063082869261</AcctSvcrRef>
<NtryDtls>
<TxDtls>
<Refs><AcctSvcrRef>202606308286926100000001</AcctSvcrRef></Refs>
<AmtDtls><TxAmt><Amt Ccy="SEK">2493.00</Amt></TxAmt></AmtDtls>
<RltdPties><Cdtr><Nm>DBE Kabel-TV AB</Nm></Cdtr></RltdPties>
<RmtInf><Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp><Nb>2114</Nb></RfrdDocInf><RfrdDocAmt><RmtdAmt Ccy="SEK">2493.00</RmtdAmt></RfrdDocAmt></Strd></RmtInf>
</TxDtls>
</NtryDtls>
<NtryDtls>
<TxDtls>
<Refs><AcctSvcrRef>202606308286926100000002</AcctSvcrRef></Refs>
<AmtDtls><TxAmt><Amt Ccy="SEK">831.00</Amt></TxAmt></AmtDtls>
<RltdPties><Cdtr><Nm>DBE Kabel-TV AB</Nm></Cdtr></RltdPties>
<RmtInf><Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp><Nb>2141</Nb></RfrdDocInf><RfrdDocAmt><RmtdAmt Ccy="SEK">831.00</RmtdAmt></RfrdDocAmt></Strd></RmtInf>
</TxDtls>
</NtryDtls>
</Ntry>
</Ntfctn>
</BkToCstmrDbtCdtNtfctn>
</Document>`

const SINGLE_SUBPAYMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02">
<BkToCstmrDbtCdtNtfctn>
<GrpHdr><MsgId>SWEDSESSDEBT202607080040406568</MsgId><CreDtTm>2026-07-08T13:15:17.399146</CreDtTm></GrpHdr>
<Ntfctn>
<Id>SWEDSESSDEBT20260708004040656800001</Id>
<Acct><Id><Othr><Id>840533338800950</Id></Othr></Id><Ccy>SEK</Ccy></Acct>
<Ntry>
<Amt Ccy="SEK">2093.00</Amt>
<CdtDbtInd>DBIT</CdtDbtInd>
<Sts>BOOK</Sts>
<BookgDt><Dt>2026-07-08</Dt></BookgDt>
<AcctSvcrRef>2026070883507530</AcctSvcrRef>
<NtryDtls>
<TxDtls>
<Refs><AcctSvcrRef>202607088350753000000001</AcctSvcrRef></Refs>
<AmtDtls><TxAmt><Amt Ccy="SEK">2093.00</Amt></TxAmt></AmtDtls>
<RltdPties><Cdtr><Nm>BYGGVAB Virserum AB</Nm></Cdtr></RltdPties>
<RmtInf><Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp><Nb>33174</Nb></RfrdDocInf><RfrdDocAmt><RmtdAmt Ccy="SEK">2093.00</RmtdAmt></RfrdDocAmt></Strd></RmtInf>
</TxDtls>
</NtryDtls>
</Ntry>
</Ntfctn>
</BkToCstmrDbtCdtNtfctn>
</Document>`

// A real incoming-payments (CRDT) "Redovisning" export, trimmed to two Ntry
// entries. Revealed two production shapes the leverantörsbetalning samples
// above never exercise: (1) RfrdDocInf/Nb is often EMPTY for these hyresavi
// payers, with the actual reference living in the free-text AddtlRmtInf
// instead; (2) one TxDtls can carry SEVERAL <Strd> blocks — a single tenant
// transfer settling two references at once (3745 + 6077 = 9822), each with
// its own RfrdDocAmt.
const CRDT_MULTI_STRD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02">
<BkToCstmrDbtCdtNtfctn>
<GrpHdr><MsgId>SWEDSESSCRED202609250043873380</MsgId><CreDtTm>2026-09-25T19:37:46.855934</CreDtTm><AddtlInf>CRED</AddtlInf></GrpHdr>
<Ntfctn>
<Id>SWEDSESSCRED20260925004387338000001</Id>
<Acct><Id><Othr><Id>840533338800950</Id></Othr></Id><Ccy>SEK</Ccy></Acct>
<Ntry>
<Amt Ccy="SEK">3000.00</Amt>
<CdtDbtInd>CRDT</CdtDbtInd>
<Sts>BOOK</Sts>
<BookgDt><Dt>2026-09-25</Dt></BookgDt>
<AcctSvcrRef>2026092588651314</AcctSvcrRef>
<NtryDtls>
<TxDtls>
<Refs><AcctSvcrRef>202609258865131400000001</AcctSvcrRef></Refs>
<AmtDtls><TxAmt><Amt Ccy="SEK">3000.00</Amt></TxAmt></AmtDtls>
<RltdPties><Dbtr><Nm>Qasa AB</Nm></Dbtr></RltdPties>
<RmtInf><Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp><Nb>415924146786850</Nb></RfrdDocInf><RfrdDocAmt><RmtdAmt Ccy="SEK">3000.00</RmtdAmt></RfrdDocAmt></Strd></RmtInf>
</TxDtls>
</NtryDtls>
</Ntry>
<Ntry>
<Amt Ccy="SEK">36461.00</Amt>
<CdtDbtInd>CRDT</CdtDbtInd>
<Sts>BOOK</Sts>
<BookgDt><Dt>2026-09-25</Dt></BookgDt>
<AcctSvcrRef>2026092588681113</AcctSvcrRef>
<NtryDtls>
<TxDtls>
<Refs><AcctSvcrRef>202609258868111300000001</AcctSvcrRef></Refs>
<AmtDtls><TxAmt><Amt Ccy="SEK">9822.00</Amt></TxAmt></AmtDtls>
<RltdPties><Dbtr><Nm>AMANDA HELLING GRAHOVIC</Nm></Dbtr></RltdPties>
<RmtInf>
<Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp></RfrdDocInf><RfrdDocAmt><RmtdAmt Ccy="SEK">3745.00</RmtdAmt></RfrdDocAmt><AddtlRmtInf>Delbet</AddtlRmtInf></Strd>
<Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp></RfrdDocInf><RfrdDocAmt><RmtdAmt Ccy="SEK">6077.00</RmtdAmt></RfrdDocAmt><AddtlRmtInf>396069</AddtlRmtInf></Strd>
</RmtInf>
</TxDtls>
</NtryDtls>
<NtryDtls>
<TxDtls>
<Refs><AcctSvcrRef>202609258868111300000004</AcctSvcrRef></Refs>
<AmtDtls><TxAmt><Amt Ccy="SEK">5951.00</Amt></TxAmt></AmtDtls>
<RltdPties><Dbtr><Nm>JENNIFER PETERSEN</Nm></Dbtr></RltdPties>
<RmtInf><Strd><RfrdDocInf><Tp><CdOrPrtry><Cd>CINV</Cd></CdOrPrtry></Tp></RfrdDocInf><RfrdDocAmt><RmtdAmt Ccy="SEK">5951.00</RmtdAmt></RfrdDocAmt><AddtlRmtInf>394460</AddtlRmtInf></Strd></RmtInf>
</TxDtls>
</NtryDtls>
</Ntry>
</Ntfctn>
</BkToCstmrDbtCdtNtfctn>
</Document>`

describe('parseCamt054: real incoming-payments (CRDT) shapes', () => {
  it('falls back to AddtlRmtInf when RfrdDocInf/Nb is empty', () => {
    const result = parseCamt054(CRDT_MULTI_STRD)
    const [, secondEntry] = result.entries
    expect(secondEntry.direction).toBe('CRDT')
    // Second Ntry's first TxDtls splits into two sub-payments (see below);
    // its third NtryDtls sub-payment (JENNIFER PETERSEN) has an empty Nb.
    const jennifer = secondEntry.subPayments.find((sp) => sp.counterpartyName === 'JENNIFER PETERSEN')
    expect(jennifer).toMatchObject({ amount: 5951, reference: '394460' })
  })

  it('splits one TxDtls into several sub-payments when it carries multiple <Strd> blocks', () => {
    const result = parseCamt054(CRDT_MULTI_STRD)
    const [, secondEntry] = result.entries
    const amanda = secondEntry.subPayments.filter((sp) => sp.counterpartyName === 'AMANDA HELLING GRAHOVIC')
    expect(amanda).toHaveLength(2)
    expect(amanda[0]).toMatchObject({ amount: 3745, reference: 'Delbet' })
    expect(amanda[1]).toMatchObject({ amount: 6077, reference: '396069' })
    expect(amanda[0].amount + amanda[1].amount).toBe(9822)
  })

  it('parses the CRDT direction and the first Ntry (a clean single reference) correctly', () => {
    const result = parseCamt054(CRDT_MULTI_STRD)
    expect(result.entries).toHaveLength(2)
    const [firstEntry] = result.entries
    expect(firstEntry).toMatchObject({ direction: 'CRDT', amount: 3000, bookingDate: '2026-09-25' })
    expect(firstEntry.subPayments).toEqual([
      { amount: 3000, counterpartyName: 'Qasa AB', reference: '415924146786850', subAcctSvcrRef: '202609258865131400000001' },
    ])
  })
})

describe('detectCamt054', () => {
  it('recognizes a camt.054 file by namespace and .xml extension', () => {
    expect(detectCamt054(TWO_SUBPAYMENT_LUMP, 'Atterredovisning.xml')).toBe(true)
  })

  it('rejects a non-.xml filename even with matching content', () => {
    expect(detectCamt054(TWO_SUBPAYMENT_LUMP, 'atterredovisning.txt')).toBe(false)
  })

  it('rejects unrelated XML', () => {
    expect(detectCamt054('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"></Document>', 'statement.xml')).toBe(false)
  })
})

describe('parseCamt054', () => {
  it('splits a two-subpayment lump entry into its individual references and amounts', () => {
    const result = parseCamt054(TWO_SUBPAYMENT_LUMP)
    expect(result.issues).toEqual([])
    expect(result.entries).toHaveLength(1)

    const [entry] = result.entries
    expect(entry.direction).toBe('DBIT')
    expect(entry.amount).toBe(3324)
    expect(entry.bookingDate).toBe('2026-06-30')
    expect(entry.acctSvcrRef).toBe('2026063082869261')
    expect(entry.subPayments).toHaveLength(2)

    expect(entry.subPayments[0]).toMatchObject({
      amount: 2493,
      counterpartyName: 'DBE Kabel-TV AB',
      reference: '2114',
    })
    expect(entry.subPayments[1]).toMatchObject({
      amount: 831,
      counterpartyName: 'DBE Kabel-TV AB',
      reference: '2141',
    })

    const subPaymentSum = entry.subPayments.reduce((s, sp) => s + sp.amount, 0)
    expect(subPaymentSum).toBe(entry.amount)
  })

  it('parses a single-subpayment entry as a 1-item list', () => {
    const result = parseCamt054(SINGLE_SUBPAYMENT)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].subPayments).toHaveLength(1)
    expect(result.entries[0].subPayments[0]).toMatchObject({
      amount: 2093,
      counterpartyName: 'BYGGVAB Virserum AB',
      reference: '33174',
    })
  })

  it('reports an error and no entries for a file with no <Ntfctn>', () => {
    const result = parseCamt054('<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.054.001.02"></Document>')
    expect(result.entries).toEqual([])
    expect(result.issues).toEqual([{ message: 'Ingen <Ntfctn> hittades i filen.', severity: 'error' }])
  })

  it('unescapes XML entities in counterparty names', () => {
    const withEntity = SINGLE_SUBPAYMENT.replace('BYGGVAB Virserum AB', 'H&amp;M Virserum AB')
    const result = parseCamt054(withEntity)
    expect(result.entries[0].subPayments[0].counterpartyName).toBe('H&M Virserum AB')
  })
})

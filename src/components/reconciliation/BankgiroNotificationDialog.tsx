'use client'

import { useCallback, useRef, useState } from 'react'
import { Upload, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { formatCurrency, formatDate } from '@/lib/utils'

interface SubPaymentMatchView {
  subPayment: { amount: number; counterpartyName: string | null; reference: string | null }
  status: 'matched' | 'ambiguous' | 'unmatched'
  invoice: {
    type: 'supplier_invoice' | 'invoice'
    id: string
    counterpartyName: string | null
    remainingAmount: number
    existingJournalEntryId: string | null
  } | null
}

interface EntryProposalView {
  entry: {
    direction: 'DBIT' | 'CRDT'
    amount: number
    bookingDate: string
    acctSvcrRef: string | null
  }
  transaction: { id: string; date: string; amount: number } | null
  transactionMatchStatus: 'matched' | 'ambiguous' | 'not_found'
  subPayments: SubPaymentMatchView[]
  fullyExplained: boolean
}

type EntryState = 'idle' | 'confirming' | 'confirmed' | 'failed'

interface BankgiroNotificationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called after at least one entry is successfully confirmed, so the caller can refresh its own view. */
  onConfirmed?: () => void
}

/**
 * Upload → match preview → per-entry confirm flow for Bankgiro
 * "Återredovisning" (camt.054) files. See
 * src/lib/reconciliation/bankgiro-notification/{parse-camt054,match}.ts and
 * app/api/reconciliation/bankgiro-notification/{parse,confirm} for the
 * server side this drives.
 */
export function BankgiroNotificationDialog({ open, onOpenChange, onConfirmed }: BankgiroNotificationDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [proposals, setProposals] = useState<EntryProposalView[] | null>(null)
  const [alreadyHandledCount, setAlreadyHandledCount] = useState(0)
  const [entryStates, setEntryStates] = useState<Record<number, EntryState>>({})
  const [entryErrors, setEntryErrors] = useState<Record<number, string>>({})

  const reset = useCallback(() => {
    setUploadError(null)
    setProposals(null)
    setAlreadyHandledCount(0)
    setEntryStates({})
    setEntryErrors({})
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  const handleFile = useCallback(async (file: File) => {
    setUploading(true)
    setUploadError(null)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await fetch('/api/reconciliation/bankgiro-notification/parse', {
        method: 'POST',
        body: formData,
      })
      const json = await res.json()
      if (!res.ok) {
        setUploadError(json?.error ?? 'Filen kunde inte tolkas.')
        return
      }
      setProposals(json.data.proposals)
      setAlreadyHandledCount(json.data.already_handled_count ?? 0)
    } catch {
      setUploadError('Uppladdningen misslyckades. Försök igen.')
    } finally {
      setUploading(false)
    }
  }, [])

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) void handleFile(file)
    },
    [handleFile],
  )

  const confirmEntry = useCallback(
    async (index: number, proposal: EntryProposalView) => {
      setEntryStates((s) => ({ ...s, [index]: 'confirming' }))
      setEntryErrors((s) => {
        const next = { ...s }
        delete next[index]
        return next
      })
      try {
        const res = await fetch('/api/reconciliation/bankgiro-notification/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transaction_id: proposal.transaction!.id,
            entry: proposal.entry,
            allocations: proposal.subPayments.map((sp) => ({
              type: sp.invoice!.type,
              id: sp.invoice!.id,
              amount: sp.invoice!.remainingAmount,
              existing_journal_entry_id: sp.invoice!.existingJournalEntryId,
            })),
          }),
        })
        const json = await res.json()
        if (!res.ok) {
          setEntryStates((s) => ({ ...s, [index]: 'failed' }))
          setEntryErrors((s) => ({ ...s, [index]: json?.error ?? 'Kunde inte bekräfta.' }))
          return
        }
        setEntryStates((s) => ({ ...s, [index]: 'confirmed' }))
        onConfirmed?.()
      } catch {
        setEntryStates((s) => ({ ...s, [index]: 'failed' }))
        setEntryErrors((s) => ({ ...s, [index]: 'Nätverksfel. Försök igen.' }))
      }
    },
    [onConfirmed],
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Importera Bankgiro-återredovisning</DialogTitle>
          <DialogDescription>
            Ladda upp en camt.054-fil (Återredovisning) från internetbanken. Klumpsummor delas
            automatiskt upp mot rätt fakturor utifrån filens referenser — du bekräftar varje post
            innan något bokförs.
          </DialogDescription>
        </DialogHeader>

        {!proposals && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-8 text-center">
            <Upload className="h-6 w-6 text-muted-foreground" />
            <input
              ref={fileInputRef}
              type="file"
              accept=".xml"
              className="hidden"
              onChange={handleFileInput}
            />
            <Button
              type="button"
              variant="outline"
              loading={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploading ? 'Läser fil…' : 'Välj fil'}
            </Button>
            {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
          </div>
        )}

        {proposals && (
          <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
            {alreadyHandledCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {alreadyHandledCount} post(er) i filen är redan bekräftade sedan tidigare och visas
                inte igen.
              </p>
            )}
            {proposals.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Inga nya poster att hantera i den här filen.
              </p>
            )}
            {proposals.map((proposal, index) => (
              <EntryCard
                key={index}
                proposal={proposal}
                state={entryStates[index] ?? 'idle'}
                error={entryErrors[index]}
                onConfirm={() => confirmEntry(index, proposal)}
              />
            ))}
            <Button type="button" variant="outline" size="sm" onClick={reset} className="self-start">
              Ladda upp en annan fil
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function EntryCard({
  proposal,
  state,
  error,
  onConfirm,
}: {
  proposal: EntryProposalView
  state: EntryState
  error?: string
  onConfirm: () => void
}) {
  const { entry, transaction, transactionMatchStatus, subPayments, fullyExplained } = proposal
  const directionLabel = entry.direction === 'DBIT' ? 'Leverantörsbetalning' : 'Kundinbetalning'

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {directionLabel} · {formatCurrency(entry.amount)} · {formatDate(entry.bookingDate)}
          </p>
          {transactionMatchStatus !== 'matched' && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3" />
              {transactionMatchStatus === 'not_found'
                ? 'Hittade ingen matchande banktransaktion — hantera manuellt.'
                : 'Flera möjliga banktransaktioner — hantera manuellt.'}
            </p>
          )}
        </div>
        {state === 'idle' && (
          <Button type="button" size="sm" disabled={!fullyExplained || !transaction} onClick={onConfirm}>
            Bekräfta
          </Button>
        )}
        {state === 'confirming' && (
          <Button type="button" size="sm" loading>
            Bokför…
          </Button>
        )}
        {state === 'confirmed' && (
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5" /> Klart
          </span>
        )}
        {state === 'failed' && (
          <Button type="button" size="sm" variant="outline" onClick={onConfirm}>
            Försök igen
          </Button>
        )}
      </div>

      {error && (
        <p className="mb-2 flex items-center gap-1 text-xs text-destructive">
          <XCircle className="h-3 w-3" /> {error}
        </p>
      )}

      <div className="space-y-1">
        {subPayments.map((sp, i) => (
          <div key={i} className="flex items-center justify-between gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {sp.subPayment.counterpartyName ?? '—'}
              {sp.subPayment.reference ? ` · ref ${sp.subPayment.reference}` : ''}
            </span>
            <span className="shrink-0 tabular-nums">{formatCurrency(sp.subPayment.amount)}</span>
            <SubPaymentStatusBadge status={sp.status} />
          </div>
        ))}
      </div>
    </div>
  )
}

function SubPaymentStatusBadge({ status }: { status: SubPaymentMatchView['status'] }) {
  if (status === 'matched') return <span className="shrink-0 text-xs text-muted-foreground">Matchad</span>
  if (status === 'ambiguous') return <Badge variant="warning">Flera träffar</Badge>
  return <Badge variant="destructive">Ej hittad</Badge>
}

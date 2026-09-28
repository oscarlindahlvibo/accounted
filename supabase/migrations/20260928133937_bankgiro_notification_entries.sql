-- Tracks which camt.054 (Bankgiro Återredovisning) lump entries have already
-- been confirmed, so re-uploading the same period's file shows those entries
-- as already handled instead of proposing them again. One row per Ntry, keyed
-- on the bank's own AcctSvcrRef for that entry.
CREATE TABLE public.bankgiro_notification_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  acct_svcr_ref text NOT NULL,
  transaction_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  direction text NOT NULL CHECK (direction IN ('DBIT', 'CRDT')),
  amount numeric NOT NULL,
  booking_date date NOT NULL,
  sub_payment_count integer NOT NULL DEFAULT 0,
  confirmed_by uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bankgiro_notification_entries_company_ref_key UNIQUE (company_id, acct_svcr_ref)
);
CREATE INDEX bankgiro_notification_entries_company_idx ON public.bankgiro_notification_entries(company_id);
CREATE INDEX bankgiro_notification_entries_transaction_idx ON public.bankgiro_notification_entries(transaction_id);

ALTER TABLE public.bankgiro_notification_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bankgiro_notification_entries FROM anon;
GRANT SELECT, INSERT ON public.bankgiro_notification_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bankgiro_notification_entries TO service_role;

CREATE POLICY bankgiro_notification_entries_read ON public.bankgiro_notification_entries
  FOR SELECT TO authenticated USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY bankgiro_notification_entries_insert ON public.bankgiro_notification_entries
  FOR INSERT TO authenticated WITH CHECK (
    confirmed_by = auth.uid() AND
    EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = bankgiro_notification_entries.company_id
        AND cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin', 'member')
    )
  );

NOTIFY pgrst, 'reload schema';

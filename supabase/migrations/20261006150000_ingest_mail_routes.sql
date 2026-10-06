-- Vibo fork: which inbound mail address delivers to which company's
-- Dokumentinkorg. Read by the IMAP poller (src/lib/vibo-ingest/mail-poll.ts)
-- with the service role only; no client policy on purpose.
CREATE TABLE public.ingest_mail_routes (
  address     text PRIMARY KEY CHECK (address = lower(address)),
  company_id  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ingest_mail_routes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ingest_mail_routes TO service_role;

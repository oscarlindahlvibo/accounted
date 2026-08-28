# Bolagsverket — VärdefullaDatamängder

Server-side integration with Bolagsverket's official "VärdefullaDatamängder"
(valuable datasets) API: free, no signed agreement required, company lookup
by Swedish org number plus digitally filed annual report retrieval.

## What this is, and what it isn't

- **`extensions/general/bolagsverket`** (a separate, pre-existing extension)
  is Bolagsverket's *digital årsredovisning* (annual report) **filing**
  integration — Accounted submitting an iXBRL report *to* Bolagsverket. It
  is unrelated to this integration and was not touched.
- **This integration** (`lib/bolagsverket/`) is the opposite direction:
  Accounted *reading* company facts and previously filed annual reports
  *from* Bolagsverket.

## What it does

- `lib/bolagsverket/organisation.ts` — look up a company by org number
  (`getBolagsverketOrganisation`), normalized to Accounted's existing
  provider-agnostic `CompanyLookupResult` shape
  (`lib/company-lookup/types.ts` — the same type the TIC extension already
  produces).
- `lib/bolagsverket/annual-reports.ts` — list a company's digitally filed
  annual reports and fetch one document (a ZIP archive; see "Annual reports"
  below for what's deliberately *not* built yet).
- `lib/bolagsverket/token.ts` — OAuth2 Client Credentials token, cached
  in-process until shortly before `expires_in`, refreshed automatically.
- `lib/bolagsverket/client.ts` — the shared authenticated request wrapper:
  timeout, retry with backoff on 429/5xx/network errors, one retry on 401
  after invalidating the cached token, RFC 7807 error mapping. Every
  request carries a generated `X-Request-Id`.

None of this is behind Accounted's extensions/capability system: org-number
lookup is core, not an add-on (mirrors `org_lookup` already being a
non-gated capability — see `lib/entitlements/keys.ts`).

## Where it's used today

- **Onboarding** (`lib/company-lookup/fetch-company-lookup.ts`, called from
  `components/onboarding/journey/OnboardingJourney.tsx`): tries Bolagsverket
  first, falls back to the TIC extension only when Bolagsverket is
  unconfigured or returns nothing. Same client function, same
  `CompanyLookupOutcome` states as before — no behavior change for
  self-hosts that haven't configured Bolagsverket yet.
- **Settings → Företag** (`components/settings/BolagsverketConnectionPanel.tsx`):
  connection status + "Testa anslutning". No connect/disconnect flow —
  Client Credentials is configured entirely via server env vars, there is
  nothing to authorize per-user.

### What was deliberately *not* changed

**Settings → Företag → Bolagsuppgifter** (`CompanyProfileSection.tsx`,
backed by `lib/company/tic-refresh.ts` / `lib/agent/composer/tic-fetch.ts`,
cached on `companies.tic_snapshot`) still uses TIC. That panel's richer
snapshot includes financial summaries, payroll history, representatives and
beneficial-owner data that TIC's Lens API provides and Bolagsverket's
VärdefullaDatamängder API does not (verified against the real OpenAPI
schema, not assumed — see "Fields NOT available" below). Swapping its
provider would silently drop fields an existing panel already shows.
Making that swap — full replacement vs. a merged view — needs a product
decision, not a guess, so it's left as a follow-up.

**Customers and suppliers** do not yet have a "Hämta från Bolagsverket"
lookup button. The backend (`/api/company-lookup/bolagsverket`) is generic
and ready for this; wiring it into those forms is a UI-only follow-up (see
TODO below) that wasn't rushed into this pass without reading those forms
properly first.

## Environment variables

```
BOLAGSVERKET_CLIENT_ID=
BOLAGSVERKET_CLIENT_SECRET=
BOLAGSVERKET_ENV=acceptance          # acceptance | production
BOLAGSVERKET_API_BASE_URL=           # required override once ENV=production
BOLAGSVERKET_TOKEN_URL=              # required override once ENV=production
BOLAGSVERKET_ORG_CACHE_TTL_MS=86400000      # default 24h
BOLAGSVERKET_DOCLIST_CACHE_TTL_MS=21600000  # default 6h
```

`BOLAGSVERKET_CLIENT_ID`/`_SECRET` are never sent to the browser, never
logged (even the token endpoint's error responses are logged with the
error code only), and never persisted to the database — they live only as
server environment variables, the same model Enable Banking and Skatteverket
already use in this codebase.

### Acceptance vs. production

Acceptance defaults are hard-coded (verified 2026-08-27 directly against
the acceptance devportal's own published OpenAPI spec at
`portal-accept2.api.bolagsverket.se`, and the token URL Bolagsverket issued
us):

- API base: `https://gw-accept2.api.bolagsverket.se/vardefulla-datamangder/v1`
- Token: `https://portal-accept2.api.bolagsverket.se/oauth2/token`

**Production is intentionally not guessed.** Bolagsverket's public
documentation and the acceptance OpenAPI spec do not state the production
hostnames. Setting `BOLAGSVERKET_ENV=production` without also setting
`BOLAGSVERKET_API_BASE_URL` and `BOLAGSVERKET_TOKEN_URL` makes every call
throw a clear `BolagsverketConfigError` naming the missing variable,
instead of silently hitting a fabricated URL. When Bolagsverket confirms
the production URLs, set those two variables — no code change needed.

## How to test

1. Set the three required env vars in `.env` (acceptance credentials).
2. Settings → Företag → the Bolagsverket panel → "Testa anslutning". It
   checks, in order: credentials present → token can be minted → `/isalive`
   answers. Never displays a token or secret.
3. Or manually: `POST /api/company-lookup/bolagsverket/test-connection`
   (authenticated).
4. To see the lookup itself: start onboarding a new company and enter a
   real Swedish org number at Step 2 — Bolagsverket answers before TIC is
   ever tried.

## Token caching

One access token is cached per Node.js process (not per request, not per
company — the org certificate/client identifies Accounted itself, not the
company being looked up). Concurrent requests during a mint share the same
in-flight promise. Re-minted automatically ~60 seconds before `expires_in`
elapses, or immediately after any 401 (the cache is dropped and the next
call re-mints once).

## Caching

- Organisation lookups: 24h (`BOLAGSVERKET_ORG_CACHE_TTL_MS`). Company facts
  change on Bolagsverket's own filing cadence — days, not minutes.
- Annual report lists: 6h (`BOLAGSVERKET_DOCLIST_CACHE_TTL_MS`).
- Both are in-process `Map`-based TTL caches
  (`lib/bolagsverket/cache.ts`), the same pattern
  `extensions/general/tic/lib/tic-client.ts` already uses. Accounted has no
  shared cache (no Redis) in this codebase, so no new caching technology
  was introduced.

## Annual reports

`GET /api/company-lookup/bolagsverket/annual-reports?org_number=...` lists
what Bolagsverket's `/dokumentlista` operation actually returns per
document: `dokumentId`, `filformat`, `rapporteringsperiodTom` (end of the
reporting period — there is no period-start field in this API),
`registreringstidpunkt`. `GET
/api/company-lookup/bolagsverket/annual-reports/[documentId]` streams the
raw document, which Bolagsverket serves as a ZIP archive
(`Content-Type: application/zip`).

**Deliberately not built:** parsing the ZIP's contents (iXBRL/XHTML) into
financial figures (nettoomsättning, resultat, tillgångar, eget kapital,
skulder, jämförelsetal). This codebase has no existing iXBRL *parser* —
`extensions/general/bolagsverket`'s XBRL code only *builds* outgoing
filings, which doesn't transfer to reading arbitrary incoming ones
correctly. Building a parser that reads real XBRL facts/contexts (not
regex over XHTML, which the task explicitly ruled out) is a real,
separate project. Shipping a guess here would violate the one rule that
matters most for financial figures: never invent a number. The document
list and raw document retrieval are ready; figure extraction is a
follow-up once there's a concrete need and a taxonomy-mapping plan.

## Known limitations / TODO

- Customers/suppliers lookup UI not wired (backend ready, see above).
- `Bolagsuppgifter` panel still on TIC (see above) — needs a product
  decision on full replacement vs. hybrid.
- Annual report figure extraction not implemented (see above).
- Production API/token URLs unconfirmed — must be set explicitly when
  Bolagsverket issues production credentials.
- `registration.fTax` / `registration.vat` are `null` for Bolagsverket
  results: VärdefullaDatamängder does not expose F-skatt or
  momsregistrering (verified against the real schema — TIC does, so its
  results are unaffected). Existing consumers already treat these as
  optional/truthy-checked values, so this degrades gracefully to "unknown,
  ask the user" rather than a wrong default.
- No `kommun`/`län`/besöksadress fields either — not present in this API
  (only `postadress`: utdelningsadress, postnummer, postort, coAdress,
  land).

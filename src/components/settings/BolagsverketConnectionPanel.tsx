'use client'

import { useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SettingsGroup, SettingsRow, SettingsRowNote } from '@/components/settings/SettingsRows'

interface TestResult {
  ok: boolean
  environment: 'acceptance' | 'production' | null
  message: string
}

/**
 * Settings → Företag: Bolagsverket connection status + "Testa anslutning".
 *
 * No connect/disconnect flow here (unlike Skatteverket's personal BankID
 * OAuth): Bolagsverket uses Client Credentials, configured entirely via
 * server env vars (BOLAGSVERKET_CLIENT_ID/_SECRET/_ENV). This panel only
 * verifies that configuration works — it never displays or stores a
 * secret, and has nothing to "connect" from the browser.
 */
export function BolagsverketConnectionPanel() {
  const [result, setResult] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)

  async function handleTest() {
    setTesting(true)
    setResult(null)
    try {
      const res = await fetch('/api/company-lookup/bolagsverket/test-connection', { method: 'POST' })
      const body = (await res.json()) as TestResult
      setResult(body)
    } catch {
      setResult({ ok: false, environment: null, message: 'Kunde inte nå Accounted-servern.' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <SettingsGroup label="Bolagsverket">
      <SettingsRow label="Status" borderless>
        {result ? (
          result.ok ? (
            <span className="text-sm text-muted-foreground">Ansluten</span>
          ) : (
            <Badge variant="destructive">Ej ansluten</Badge>
          )
        ) : (
          <SettingsRowNote>Organisationsuppslagning via Bolagsverkets officiella API.</SettingsRowNote>
        )}
      </SettingsRow>

      {result?.environment && (
        <SettingsRow label="Miljö" borderless>
          <SettingsRowNote>{result.environment === 'production' ? 'Produktion' : 'Acceptans'}</SettingsRowNote>
        </SettingsRow>
      )}

      <SettingsRow label="Anslutning" borderless>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <Button type="button" size="sm" variant="outline" onClick={handleTest} loading={testing}>
            {testing ? 'Testar…' : 'Testa anslutning'}
          </Button>
          {result && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {result.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <XCircle className="h-3.5 w-3.5 text-destructive" />
              )}
              {result.message}
            </span>
          )}
        </div>
      </SettingsRow>
    </SettingsGroup>
  )
}

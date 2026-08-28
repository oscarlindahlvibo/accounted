import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { testBolagsverketConnection } from '@/lib/bolagsverket/test-connection'

/**
 * POST /api/company-lookup/bolagsverket/test-connection
 * Settings → "Testa anslutning". Never returns credentials or tokens.
 */
export async function POST() {
  const { error } = await requireAuth()
  if (error) return error

  const result = await testBolagsverketConnection()
  return NextResponse.json(result, { status: result.ok ? 200 : 503 })
}

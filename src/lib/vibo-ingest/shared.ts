import type { SupabaseClient } from '@supabase/supabase-js'
import {
  uploadAndExtract,
  sanitiseFilename,
  sanitiseMime,
  MAX_FILE_SIZE,
  EMAIL_ALLOWED_MIME_TYPES,
  UPLOAD_ALLOWED_MIME_TYPES,
  type EmailMeta,
} from '@/extensions/general/invoice-inbox/lib/upload-and-extract'

export interface IngestFile {
  name: string
  buffer: Buffer
  type: string
}

export type IngestOutcome = 'ingested' | 'unsupported' | 'too_large' | 'failed'

/** JSON env var -> object, or null when unset/invalid. */
export function readJsonEnv<T>(name: string): T | null {
  const raw = process.env[name]
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** The company owner is the actor for documents that arrive unattended. */
export async function resolveOwnerId(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const { data } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId)
    .eq('role', 'owner')
    .order('created_at')
    .limit(1)
  return (data?.[0]?.user_id as string | undefined) ?? null
}

export function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** Puts one file into the company's Dokumentinkorg (dedupes on content). */
export async function ingestFile(
  supabase: SupabaseClient,
  ownerId: string,
  companyId: string,
  file: IngestFile,
  source: 'email' | 'upload',
  emailMeta?: EmailMeta,
): Promise<IngestOutcome> {
  const type = sanitiseMime(file.type)
  const allowed = source === 'email' ? EMAIL_ALLOWED_MIME_TYPES : UPLOAD_ALLOWED_MIME_TYPES
  if (!allowed.has(type)) return 'unsupported'
  if (file.buffer.byteLength > MAX_FILE_SIZE) return 'too_large'
  try {
    await uploadAndExtract(
      supabase,
      ownerId,
      companyId,
      { name: sanitiseFilename(file.name, 'underlag'), buffer: toArrayBuffer(file.buffer), type },
      source,
      emailMeta,
    )
    return 'ingested'
  } catch (err) {
    console.error('[vibo-ingest] ingest failed:', err instanceof Error ? err.message : err)
    return 'failed'
  }
}

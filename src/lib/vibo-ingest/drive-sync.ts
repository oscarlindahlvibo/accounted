import { createSign } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ingestFile, readJsonEnv, resolveOwnerId } from './shared'

const API = 'https://www.googleapis.com/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const BATCH = 15
const DONE_NAME = 'Behandlade'
const FAILED_NAME = 'Fel'

export interface DriveSyncResult {
  configured: boolean
  files: number
  ingested: number
  failed: number
}

interface ServiceAccount { client_email: string; private_key: string }
interface DriveFile { id: string; name: string; mimeType: string }

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url')

async function accessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3300,
  }))
  const signer = createSign('RSA-SHA256')
  signer.update(header + '.' + claim)
  const jwt = header + '.' + claim + '.' + signer.sign(sa.private_key).toString('base64url')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  })
  const body = await res.json() as { access_token?: string; error_description?: string }
  if (!res.ok || !body.access_token) throw new Error('Drive auth failed: ' + (body.error_description ?? res.status))
  return body.access_token
}

async function drive<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, { ...init, headers: { Authorization: 'Bearer ' + token, ...(init?.headers ?? {}) } })
  if (!res.ok) throw new Error('Drive ' + res.status + ' ' + (await res.text()).slice(0, 200))
  return res.json() as Promise<T>
}

const q = (s: string) => encodeURIComponent(s)
const SHARED = '&supportsAllDrives=true&includeItemsFromAllDrives=true'

async function ensureSubfolder(token: string, parentId: string, name: string): Promise<string> {
  const found = await drive<{ files: { id: string }[] }>(
    token,
    '/files?q=' + q("'" + parentId + "' in parents and name='" + name + "' and mimeType='" + FOLDER_MIME + "' and trashed=false") + '&fields=files(id)' + SHARED,
  )
  if (found.files[0]) return found.files[0].id
  const created = await drive<{ id: string }>(token, '/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  })
  return created.id
}

async function moveFile(token: string, fileId: string, fromId: string, toId: string): Promise<void> {
  await drive(token, '/files/' + fileId + '?addParents=' + toId + '&removeParents=' + fromId + '&supportsAllDrives=true', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
}

async function download(token: string, f: DriveFile): Promise<{ buffer: Buffer; type: string; name: string }> {
  const native = f.mimeType.startsWith('application/vnd.google-apps.')
  const url = native
    ? API + '/files/' + f.id + '/export?mimeType=application/pdf'
    : API + '/files/' + f.id + '?alt=media&supportsAllDrives=true'
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } })
  if (!res.ok) throw new Error('Drive download ' + res.status)
  const name = native && !f.name.toLowerCase().endsWith('.pdf') ? f.name + '.pdf' : f.name
  return { buffer: Buffer.from(await res.arrayBuffer()), type: native ? 'application/pdf' : f.mimeType, name }
}

/**
 * Pulls new files from one Drive folder per company (INGEST_DRIVE_FOLDERS:
 * company id -> folder id) into the company's Dokumentinkorg and moves each
 * file to "Behandlade" (or "Fel" when it cannot be read). The folder must be
 * shared with the service account as editor.
 */
export async function syncDriveFolders(supabase: SupabaseClient): Promise<DriveSyncResult> {
  const saRaw = process.env.INGEST_GOOGLE_SA_JSON_B64
  const folders = readJsonEnv<Record<string, string>>('INGEST_DRIVE_FOLDERS')
  const result: DriveSyncResult = { configured: false, files: 0, ingested: 0, failed: 0 }
  if (!saRaw || !folders) return result
  result.configured = true
  const sa = JSON.parse(Buffer.from(saRaw, 'base64').toString('utf8')) as ServiceAccount
  const token = await accessToken(sa)

  for (const [companyId, folderId] of Object.entries(folders)) {
    const ownerId = await resolveOwnerId(supabase, companyId)
    if (!ownerId) continue
    const list = await drive<{ files: DriveFile[] }>(
      token,
      '/files?q=' + q("'" + folderId + "' in parents and trashed=false and mimeType!='" + FOLDER_MIME + "'") +
        '&fields=files(id,name,mimeType)&orderBy=createdTime&pageSize=' + BATCH + SHARED,
    )
    if (list.files.length === 0) continue
    const doneId = await ensureSubfolder(token, folderId, DONE_NAME)
    const failedId = await ensureSubfolder(token, folderId, FAILED_NAME)
    for (const f of list.files) {
      result.files++
      let ok = false
      try {
        const d = await download(token, f)
        ok = (await ingestFile(supabase, ownerId, companyId, { name: d.name, buffer: d.buffer, type: d.type }, 'upload')) === 'ingested'
      } catch (err) {
        console.error('[vibo-ingest/drive] file failed:', err instanceof Error ? err.message : err)
      }
      if (ok) result.ingested++
      else result.failed++
      await moveFile(token, f.id, folderId, ok ? doneId : failedId).catch((err) =>
        console.error('[vibo-ingest/drive] move failed:', err instanceof Error ? err.message : err),
      )
    }
  }
  return result
}

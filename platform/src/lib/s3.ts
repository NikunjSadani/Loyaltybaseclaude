/**
 * GCS storage helpers — drop-in replacement for the old AWS S3 module.
 * All exported function signatures are unchanged; consumers need no edits.
 *
 * Auth:
 *   Cloud Run  → Application Default Credentials (service account attached to the service)
 *   Local dev  → set GOOGLE_APPLICATION_CREDENTIALS=/path/to/dev-sa-key.json
 *
 * Signed URLs require the Cloud Run service account to have
 * roles/iam.serviceAccountTokenCreator on itself (see terraform/iam.tf).
 */

import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

// ─── GCS Client ───────────────────────────────────────────────────────────────

const storage = new Storage({
  projectId: process.env.GCP_PROJECT_ID,
});

const BUCKET = process.env.GCS_BUCKET ?? 'gifsy-platform-files';
const PRESIGNED_URL_EXPIRY = 3600; // seconds

// ─── Key Generation ───────────────────────────────────────────────────────────

/**
 * Generate a unique GCS object key within a folder.
 * e.g. generateKey('kyc', 'pan.jpg') → 'kyc/2024-01/uuid-pan.jpg'
 */
export function generateKey(folder: string, filename: string): string {
  const ext      = path.extname(filename);
  const base     = path.basename(filename, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
  const yearMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  return `${folder}/${yearMonth}/${uuidv4()}-${base}${ext}`;
}

// ─── Upload ───────────────────────────────────────────────────────────────────

/**
 * Upload a Buffer to GCS and return the gs:// public URL.
 * The file is private by default — use getSignedUrl to generate temporary access URLs.
 */
export async function uploadFile(
  file: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  await storage.bucket(BUCKET).file(key).save(file, {
    contentType,
    resumable: false,           // use simple upload for files < 5MB (typical for reports/KYC)
  });
  return `https://storage.googleapis.com/${BUCKET}/${key}`;
}

// ─── Signed URL ───────────────────────────────────────────────────────────────

/**
 * Generate a V4 signed GET URL for a private GCS object.
 * Requires the running service account to have roles/iam.serviceAccountTokenCreator on itself.
 */
export async function getSignedUrl(key: string, expiresIn = PRESIGNED_URL_EXPIRY): Promise<string> {
  const [url] = await storage.bucket(BUCKET).file(key).getSignedUrl({
    version: 'v4',
    action:  'read',
    expires: Date.now() + expiresIn * 1000,
  });
  return url;
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Delete an object from GCS.
 */
export async function deleteFile(key: string): Promise<void> {
  await storage.bucket(BUCKET).file(key).delete();
}

// ─── Legacy aliases (kept for backward compatibility) ─────────────────────────

/** @deprecated Use uploadFile instead */
export async function uploadToS3(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string,
): Promise<string> {
  return uploadFile(Buffer.from(body), key, contentType);
}

/** @deprecated Use getSignedUrl instead */
export async function getPresignedUrl(key: string, expiresIn = PRESIGNED_URL_EXPIRY): Promise<string> {
  return getSignedUrl(key, expiresIn);
}

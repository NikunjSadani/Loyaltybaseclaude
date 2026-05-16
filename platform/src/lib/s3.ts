import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl as awsGetSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

// ─── S3 Client ────────────────────────────────────────────────────────────────

const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
});

const BUCKET = process.env.S3_BUCKET ?? 'loyalty-platform-uploads';
const PRESIGNED_URL_EXPIRY = 3600; // seconds

// ─── Key Generation ───────────────────────────────────────────────────────────

/**
 * Generate a unique S3 key for a file within a folder.
 * e.g. generateKey('kyc', 'pan.jpg') → 'kyc/2024-01/uuid-pan.jpg'
 */
export function generateKey(folder: string, filename: string): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
  const yearMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
  return `${folder}/${yearMonth}/${uuidv4()}-${base}${ext}`;
}

// ─── Upload ───────────────────────────────────────────────────────────────────

/**
 * Upload a Buffer to S3 and return the public URL.
 */
export async function uploadFile(
  file: Buffer,
  key: string,
  contentType: string
): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file,
      ContentType: contentType,
    })
  );
  return `https://${BUCKET}.s3.${process.env.AWS_REGION ?? 'ap-south-1'}.amazonaws.com/${key}`;
}

// ─── Signed URL ───────────────────────────────────────────────────────────────

/**
 * Generate a pre-signed GET URL for a private S3 object.
 */
export async function getSignedUrl(key: string, expiresIn = PRESIGNED_URL_EXPIRY): Promise<string> {
  return awsGetSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn }
  );
}

// ─── Delete ───────────────────────────────────────────────────────────────────

/**
 * Delete an object from S3.
 */
export async function deleteFile(key: string): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({ Bucket: BUCKET, Key: key })
  );
}

// ─── Legacy alias ─────────────────────────────────────────────────────────────

/** @deprecated Use uploadFile instead */
export async function uploadToS3(
  key: string,
  body: Buffer | Uint8Array,
  contentType: string
): Promise<string> {
  return uploadFile(Buffer.from(body), key, contentType);
}

/** @deprecated Use getSignedUrl instead */
export async function getPresignedUrl(key: string, expiresIn = PRESIGNED_URL_EXPIRY): Promise<string> {
  return getSignedUrl(key, expiresIn);
}

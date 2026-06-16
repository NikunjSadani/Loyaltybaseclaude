import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'node:crypto';
import * as path from 'path';

/**
 * GCS object storage — the Nest port of platform/src/lib/s3.ts (function
 * signatures preserved). Files are private by default; use getSignedUrl for
 * temporary read access.
 *
 * Auth: Cloud Run → Application Default Credentials (attached service account);
 * local dev → GOOGLE_APPLICATION_CREDENTIALS=/path/to/dev-sa-key.json.
 * Signed URLs need roles/iam.serviceAccountTokenCreator on the SA (terraform/iam.tf).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly storage: Storage;
  private readonly bucket: string;
  private readonly defaultExpirySec = 3600;

  constructor(private readonly config: ConfigService) {
    this.storage = new Storage({ projectId: this.config.get<string>('GCP_PROJECT_ID') });
    this.bucket = this.config.get<string>('GCS_BUCKET') ?? 'gifsy-platform-files';
  }

  /**
   * Generate a unique object key within a folder.
   * e.g. generateKey('kyc', 'pan.jpg') → 'kyc/2024-01/uuid-pan.jpg'
   */
  generateKey(folder: string, filename: string): string {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
    const yearMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
    return `${folder}/${yearMonth}/${randomUUID()}-${base}${ext}`;
  }

  /** The canonical (private) object URL for a key — same form uploadFile returns. */
  publicUrl(key: string): string {
    return `https://storage.googleapis.com/${this.bucket}/${key}`;
  }

  /** Upload a Buffer and return the (private) object URL. */
  async uploadFile(file: Buffer, key: string, contentType: string): Promise<string> {
    await this.storage.bucket(this.bucket).file(key).save(file, {
      contentType,
      resumable: false, // simple upload for typical KYC/report files (< 5MB)
    });
    return this.publicUrl(key);
  }

  /** V4 signed GET URL for a private object. */
  async getSignedUrl(key: string, expiresInSec = this.defaultExpirySec): Promise<string> {
    const [url] = await this.storage.bucket(this.bucket).file(key).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresInSec * 1000,
    });
    return url;
  }

  /** Delete an object. */
  async deleteFile(key: string): Promise<void> {
    await this.storage.bucket(this.bucket).file(key).delete();
  }
}

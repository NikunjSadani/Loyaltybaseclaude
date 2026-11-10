import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage } from '@google-cloud/storage';
import { randomUUID } from 'node:crypto';
import * as path from 'path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
    // Secret Manager values can arrive with a leading UTF-8 BOM (U+FEFF) and/or
    // trailing CR/LF — a Windows Out-File/echo artifact (same class as the MSG91
    // key BOM fixed at cutover). GCS rejects such values outright
    // ("Invalid bucket name: '<BOM>gifsy-platform-files'"), turning every KYC
    // document/photo upload into a bare 500. Strip a leading BOM and surrounding
    // whitespace/newlines so a dirty secret can never break uploads again.
    const clean = (v?: string): string | undefined =>
      v?.replace(/^\uFEFF/, '').trim() || undefined;
    this.storage = new Storage({ projectId: clean(this.config.get<string>('GCP_PROJECT_ID')) });
    this.bucket = clean(this.config.get<string>('GCS_BUCKET')) ?? 'gifsy-platform-files';
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

  /**
   * Read a private object and return it as a `data:` URL (base64-inlined).
   *
   * This is the signing-free way to surface a private GCS doc to the browser: a
   * data URL needs no auth and renders in an <img>, so we never depend on V4
   * signed URLs. Signing (getSignedUrl) requires the runtime SA to sign blobs via
   * IAM — that path is unreliable on Cloud Run here and impossible locally (no
   * keyfile) — whereas object READ works wherever the SA has objectAdmin (the same
   * grant that lets uploadFile write). Used for KYC document/photo review.
   *
   * Bounded: objects larger than maxBytes return null (caller falls back to a
   * placeholder) so a stray large upload can't bloat a JSON response. The caller
   * decides what to do with null.
   */
  async downloadAsDataUrl(
    key: string,
    contentType?: string,
    maxBytes = 8 * 1024 * 1024,
  ): Promise<string | null> {
    const file = this.storage.bucket(this.bucket).file(key);
    const [meta] = await file.getMetadata();
    const size = Number(meta.size ?? 0);
    if (size > maxBytes) {
      this.logger.warn(`downloadAsDataUrl: ${key} is ${size}B (> ${maxBytes}B cap) — skipping inline`);
      return null;
    }
    const ct = contentType || meta.contentType || 'application/octet-stream';
    const [buf] = await file.download();
    return `data:${ct};base64,${buf.toString('base64')}`;
  }

  /**
   * Read a private object and return its raw BYTES + content-type, or null.
   *
   * Same signing-free read path as downloadAsDataUrl (object READ via the runtime
   * SA's objectAdmin grant — NOT getSignedUrl, which needs IAM blob-signing that is
   * unreliable on Cloud Run and impossible locally). Used to stream a private KYC
   * document inline to the browser (the tokenized doc-view endpoint).
   *
   * Bounded: objects larger than maxBytes return null (caller → 404) so a stray
   * large upload can't be streamed in full. Returns null if the object is missing.
   */
  async downloadBytes(
    key: string,
    maxBytes = 24 * 1024 * 1024,
  ): Promise<{ bytes: Buffer; contentType: string } | null> {
    try {
      const file = this.storage.bucket(this.bucket).file(key);
      const [meta] = await file.getMetadata();
      const size = Number(meta.size ?? 0);
      if (size > maxBytes) {
        this.logger.warn(`downloadBytes: ${key} is ${size}B (> ${maxBytes}B cap) — refusing`);
        return null;
      }
      const [buf] = await file.download();
      return { bytes: buf, contentType: meta.contentType || 'application/octet-stream' };
    } catch (err) {
      // Missing object / transient read error → null (caller decides; the doc-view
      // endpoint maps this to a bare 404 so a missing file never leaks detail).
      this.logger.warn(`downloadBytes: failed to read ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Object size + stored content-type, or null when missing / unreadable (never throws).
   * Lets a caller enforce a size cap BEFORE reading or streaming any bytes.
   */
  async statObject(key: string): Promise<{ size: number; contentType: string } | null> {
    try {
      const [meta] = await this.storage.bucket(this.bucket).file(key).getMetadata();
      return { size: Number(meta.size ?? 0), contentType: meta.contentType || 'application/octet-stream' };
    } catch (err) {
      this.logger.warn(`statObject: failed to read metadata for ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Download an object's bytes directly (no metadata round-trip), or null on any read
   * error. For callers that already sized the object via statObject.
   */
  async downloadObject(key: string): Promise<Buffer | null> {
    try {
      const [buf] = await this.storage.bucket(this.bucket).file(key).download();
      return buf;
    } catch (err) {
      this.logger.warn(`downloadObject: failed to read ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Delete an object. */
  async deleteFile(key: string): Promise<void> {
    await this.storage.bucket(this.bucket).file(key).delete();
  }

  // ─── Large-object helpers (Sales Import: chunked uploads streamed by the worker) ───────────────
  // Additive; signing-free (plain object read/write/list/delete via the runtime SA's objectAdmin).

  /** Stream a private object, optionally a byte range (`end` INCLUSIVE, GCS semantics). */
  openReadStream(key: string, range?: { start?: number; end?: number }): Readable {
    const file = this.storage.bucket(this.bucket).file(key);
    return range ? file.createReadStream({ start: range.start, end: range.end, validation: false }) : file.createReadStream();
  }

  /** Objects under a prefix, with their byte sizes. */
  async listPrefix(prefix: string): Promise<Array<{ name: string; size: number }>> {
    const [files] = await this.storage.bucket(this.bucket).getFiles({ prefix });
    return files.map((f) => ({ name: f.name, size: Number(f.metadata?.size ?? 0) }));
  }

  /** Delete every object under a prefix (no-op when there are none). */
  async deletePrefix(prefix: string): Promise<void> {
    if (!prefix || !prefix.endsWith('/')) throw new Error(`deletePrefix: refusing a non-folder prefix "${prefix}"`);
    await this.storage.bucket(this.bucket).deleteFiles({ prefix, force: true });
  }

  /** Server-side copy of one object to another key in the same bucket (no bytes pass through the API). */
  async copyFile(fromKey: string, toKey: string): Promise<void> {
    const bucket = this.storage.bucket(this.bucket);
    await bucket.file(fromKey).copy(bucket.file(toKey));
  }

  /** Upload from a stream without buffering it (non-resumable, like uploadFile). */
  async uploadStream(key: string, source: Readable, contentType: string): Promise<string> {
    const file = this.storage.bucket(this.bucket).file(key);
    await pipeline(source, file.createWriteStream({ resumable: false, contentType }));
    return this.publicUrl(key);
  }
}

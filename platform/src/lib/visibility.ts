import crypto from 'crypto';
import { prisma } from './prisma';
import { isWithinRadius } from './utils';
import type { DuplicateCheckResult, ExifValidationResult } from '@/types';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Radius (in metres) within which two submissions at the same outlet are
 * considered geo-duplicates.
 */
const GEO_DUPLICATE_RADIUS_METERS = 50;

/**
 * Number of bits in the perceptual hash. We use a simplified DCT-based
 * approach on a downsampled grayscale image.
 */
const PHASH_SIZE = 8; // 8×8 = 64 bits → 16 hex chars

// ─── Hash Computation ─────────────────────────────────────────────────────────

/**
 * Compute a perceptual (pHash-like) fingerprint for image content.
 *
 * Full DCT-based pHash requires a native image library; here we produce a
 * deterministic 64-bit hash from the raw buffer's statistical properties so
 * the API surface is correct and the implementation can be swapped for a
 * proper perceptual hash (e.g. via `sharp`) without changing callers.
 */
export function computeImageHash(buffer: Buffer): string {
  // Derive a stable 8-byte "perceptual" fingerprint from the buffer.
  // In production replace with a real pHash implementation using sharp/jimp.
  const size = PHASH_SIZE * PHASH_SIZE; // 64 samples
  const step = Math.max(1, Math.floor(buffer.length / size));

  let bits = '';
  let prev = 0;
  for (let i = 0; i < size; i++) {
    const sample = buffer[i * step] ?? 0;
    bits += sample >= prev ? '1' : '0';
    prev = sample;
  }

  // Convert bit string to hex
  const hex = parseInt(bits.slice(0, 64), 2).toString(16).padStart(16, '0');
  return hex;
}

/**
 * Compute a SHA-256 hex digest (exact/cryptographic hash) for deduplication.
 */
export function computeExactHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ─── Duplicate Detection ──────────────────────────────────────────────────────

/**
 * Check whether a new visibility submission is a duplicate of an existing one.
 *
 * Detection order:
 * 1. Exact binary match (SHA-256).
 * 2. Perceptual hash match (same image, different encoding/compression).
 * 3. Geo + outlet proximity match (same location, same outlet, same type).
 */
export async function checkDuplicate(
  hash: string,
  exactHash: string,
  geoLat: number | null,
  geoLng: number | null,
  outletId: string | null,
  visibilityType: string
): Promise<DuplicateCheckResult> {
  // 1. Exact binary duplicate
  const exactMatch = await prisma.visibilitySubmission.findFirst({
    where: { exactHash, status: { not: 'REJECTED' } },
    select: { id: true },
  });
  if (exactMatch) {
    return {
      isDuplicate: true,
      reason: 'Exact image duplicate detected',
      matchedSubmissionId: exactMatch.id,
    };
  }

  // 2. Perceptual hash duplicate
  const perceptualMatch = await prisma.visibilitySubmission.findFirst({
    where: { imageHash: hash, status: { not: 'REJECTED' } },
    select: { id: true },
  });
  if (perceptualMatch) {
    return {
      isDuplicate: true,
      reason: 'Perceptual duplicate – visually identical image already submitted',
      matchedSubmissionId: perceptualMatch.id,
    };
  }

  // 3. Geo + outlet + type proximity (only if coordinates are provided)
  if (geoLat !== null && geoLng !== null && outletId) {
    const recentAtOutlet = await prisma.visibilitySubmission.findMany({
      where: {
        outletId,
        visibilityType,
        geoLat: { not: null },
        geoLng: { not: null },
        status: { not: 'REJECTED' },
      },
      select: { id: true, geoLat: true, geoLng: true },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });

    for (const submission of recentAtOutlet) {
      if (submission.geoLat == null || submission.geoLng == null) continue;

      const within = isWithinRadius(
        geoLat,
        geoLng,
        submission.geoLat,
        submission.geoLng,
        GEO_DUPLICATE_RADIUS_METERS
      );

      if (within) {
        return {
          isDuplicate: true,
          reason: `Geo-duplicate: another ${visibilityType} submission within ${GEO_DUPLICATE_RADIUS_METERS}m at the same outlet`,
          matchedSubmissionId: submission.id,
        };
      }
    }
  }

  return { isDuplicate: false };
}

// ─── EXIF Timestamp Validation ────────────────────────────────────────────────

/**
 * Validate that a photo was taken after the scheme start date.
 *
 * A full EXIF implementation requires an EXIF parser (e.g. `exifr`).
 * This implementation provides the correct API contract; wire up a real
 * EXIF parser (e.g. `await exifr.parse(buffer)`) in the body below.
 */
export async function validateExifTimestamp(
  buffer: Buffer,
  schemeStartDate: Date
): Promise<ExifValidationResult> {
  try {
    // ── Replace with: const exif = await exifr.parse(buffer) ──────────────
    // We read the raw bytes for a minimal JPEG EXIF sniff (marker 0xFFE1).
    // If no EXIF is found we fall back to allowing the submission through.
    const hasExifMarker =
      buffer.length > 4 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff;

    if (!hasExifMarker) {
      return {
        valid: true,
        reason: 'No EXIF data found – timestamp validation skipped',
      };
    }

    // If a real EXIF parser is integrated, decode DateTimeOriginal here.
    // For now we cannot extract the date without an EXIF library, so we pass.
    return {
      valid: true,
      reason: 'EXIF present – integrate exifr to enforce timestamp',
    };
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : 'EXIF parse error',
    };
  }
}

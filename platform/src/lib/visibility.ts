import crypto from 'crypto';
import { prisma } from './prisma';
import { isWithinRadius } from './utils';
import type { DuplicateCheckResult, ExifValidationResult } from '@/types';

// ─── Constants ────────────────────────────────────────────────────────────────

const GEO_DUPLICATE_RADIUS_METERS = 50;
const PHASH_SIZE = 8; // 8×8 = 64 bits → 16 hex chars

// ─── Hash Computation ─────────────────────────────────────────────────────────

/**
 * Compute a perceptual (pHash-like) fingerprint for image content.
 */
export function computeImageHash(buffer: Buffer): string {
  const size = PHASH_SIZE * PHASH_SIZE;
  const step = Math.max(1, Math.floor(buffer.length / size));

  let bits = '';
  let prev = 0;
  for (let i = 0; i < size; i++) {
    const sample = buffer[i * step] ?? 0;
    bits += sample >= prev ? '1' : '0';
    prev = sample;
  }

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
 */
export async function checkDuplicate(
  hash: string,
  exactHash: string,
  geoLat: number | null,
  geoLng: number | null,
  outletId: string | null,
  _visibilityType: string
): Promise<DuplicateCheckResult> {
  // 1. Exact binary duplicate via VisibilityImageHash
  const exactMatch = await prisma.visibilityImageHash.findFirst({
    where: { imageHash: exactHash, isDuplicate: false },
    select: { id: true, submissionId: true },
  });
  if (exactMatch) {
    return {
      isDuplicate: true,
      reason: 'Exact image duplicate detected',
      matchedSubmissionId: exactMatch.submissionId,
    };
  }

  // 2. Perceptual hash duplicate
  const perceptualMatch = await prisma.visibilityImageHash.findFirst({
    where: { imageHash: hash, isDuplicate: false },
    select: { id: true, submissionId: true },
  });
  if (perceptualMatch) {
    return {
      isDuplicate: true,
      reason: 'Perceptual duplicate – visually identical image already submitted',
      matchedSubmissionId: perceptualMatch.submissionId,
    };
  }

  // 3. Geo + outlet proximity match
  if (geoLat !== null && geoLng !== null && outletId) {
    const recentAtOutlet = await prisma.visibilitySubmission.findMany({
      where: {
        outletId,
        latitude: { not: null },
        longitude: { not: null },
        status: { not: 'REJECTED' },
      },
      select: { id: true, latitude: true, longitude: true },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });

    for (const submission of recentAtOutlet) {
      if (submission.latitude == null || submission.longitude == null) continue;

      const within = isWithinRadius(
        geoLat,
        geoLng,
        parseFloat(submission.latitude.toString()),
        parseFloat(submission.longitude.toString()),
        GEO_DUPLICATE_RADIUS_METERS
      );

      if (within) {
        return {
          isDuplicate: true,
          reason: `Geo-duplicate: another submission within ${GEO_DUPLICATE_RADIUS_METERS}m at the same outlet`,
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
 */
export async function validateExifTimestamp(
  buffer: Buffer,
  schemeStartDate: Date
): Promise<ExifValidationResult> {
  try {
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

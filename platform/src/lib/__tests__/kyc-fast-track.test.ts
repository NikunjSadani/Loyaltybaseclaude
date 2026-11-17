/// <reference types="vitest/globals" />
/**
 * kyc-fast-track (GIFSY-reject fast-track) — the shared parser + copy.
 * F5: an empty previousSubmissionId keeps the marker (the skip notice is never silently dropped; only
 *     the link hides). F7: null / absent / non-object (a flag-off tenant's response omits the key) → null.
 * F3: one plain wording across surfaces.
 */
import { describe, it, expect } from 'vitest';
import {
  FAST_TRACK_HEADLINE,
  FAST_TRACK_PREVIOUS_FALLBACK,
  FAST_TRACK_QUEUE_BADGE,
  FAST_TRACK_SALES_NOTE,
  FAST_TRACK_SKIPPED_SUBLABEL,
  parseFastTrack,
} from '../kyc-fast-track';

const at = new Date(Date.now() - 86_400_000).toISOString();

describe('parseFastTrack', () => {
  it('a full marker passes through', () => {
    expect(parseFastTrack({ previousSubmissionId: 'p1', previousRejectedAt: at })).toEqual({
      previousSubmissionId: 'p1',
      previousRejectedAt: at,
    });
  });

  it('F5: empty / missing previousSubmissionId KEEPS the marker (link hidden by the caller)', () => {
    expect(parseFastTrack({ previousSubmissionId: '', previousRejectedAt: at })).toEqual({
      previousSubmissionId: '',
      previousRejectedAt: at,
    });
    expect(parseFastTrack({ previousRejectedAt: at })).toEqual({ previousSubmissionId: '', previousRejectedAt: at });
    expect(parseFastTrack({ previousSubmissionId: 7 })).toEqual({ previousSubmissionId: '', previousRejectedAt: '' });
  });

  it('F7: null / absent / non-object → null (renders nothing)', () => {
    expect(parseFastTrack(null)).toBeNull();
    expect(parseFastTrack(undefined)).toBeNull();
    expect(parseFastTrack('x')).toBeNull();
    expect(parseFastTrack(1)).toBeNull();
    expect(parseFastTrack([])).toBeNull();
  });
});

describe('F3 copy', () => {
  it('uses one plain wording', () => {
    expect(FAST_TRACK_HEADLINE).toBe(
      'Resubmitted after a GIFSY rejection — sent directly to GIFSY; managers did not re-approve.',
    );
    expect(FAST_TRACK_QUEUE_BADGE).toBe('Resubmission · no manager re-approval');
    expect(FAST_TRACK_SALES_NOTE).toBe('Sent directly to Gifsy. Your manager does not need to approve it again.');
    expect(FAST_TRACK_SKIPPED_SUBLABEL).toBe('Not needed — resent after Gifsy rejection');
    expect(FAST_TRACK_PREVIOUS_FALLBACK).toBe('Previous KYC was rejected by GIFSY');
  });
});

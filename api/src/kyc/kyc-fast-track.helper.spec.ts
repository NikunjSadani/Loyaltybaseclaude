import {
  fastTrackFromHistory,
  gifsyRejectionAfterManagers,
  hasFastTrackMarker,
  isFastTrackRow,
  kycRoutingLabel,
  loadKycFastTrackMap,
  KYC_FAST_TRACK_MARKER,
} from './kyc-fast-track.helper';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
const ftMeta = (prev = 's0', rejectedAt = hoursAgo(10)) => ({
  fastTrack: KYC_FAST_TRACK_MARKER,
  previousSubmissionId: prev,
  previousRejectedAt: rejectedAt.toISOString(),
});

describe('kyc-fast-track.helper', () => {
  describe('isFastTrackRow / hasFastTrackMarker', () => {
    it('only the DRAFT→PENDING_GIFSY edge carrying the marker counts', () => {
      expect(isFastTrackRow({ fromStatus: 'DRAFT', toStatus: 'PENDING_GIFSY', metadata: ftMeta() })).toBe(true);
      expect(isFastTrackRow({ fromStatus: 'PENDING_SO_APPROVAL', toStatus: 'PENDING_GIFSY', metadata: ftMeta() })).toBe(false);
      expect(isFastTrackRow({ fromStatus: 'DRAFT', toStatus: 'PENDING_GIFSY', metadata: { stage: 'FIRST_APPROVER' } })).toBe(false);
      expect(isFastTrackRow({ fromStatus: 'DRAFT', toStatus: 'PENDING_GIFSY', metadata: null })).toBe(false);
      expect(isFastTrackRow(null)).toBe(false);
      expect(hasFastTrackMarker(['x'])).toBe(false);
      expect(hasFastTrackMarker(ftMeta())).toBe(true);
    });
  });

  describe('fastTrackFromHistory', () => {
    it('returns the API shape for a fast-tracked submission, null otherwise', () => {
      const at = hoursAgo(30);
      expect(
        fastTrackFromHistory([
          { fromStatus: 'DRAFT', toStatus: 'PENDING_GIFSY', createdAt: new Date(), metadata: ftMeta('s-old', at) },
        ]),
      ).toEqual({ previousSubmissionId: 's-old', previousRejectedAt: at.toISOString() });
      expect(fastTrackFromHistory([{ fromStatus: 'DRAFT', toStatus: 'PENDING_SO_APPROVAL', createdAt: new Date() }])).toBeNull();
      expect(fastTrackFromHistory(undefined)).toBeNull();
      expect(fastTrackFromHistory([])).toBeNull();
    });

    it('a row missing previousRejectedAt falls back to the routing row time (never a garbage value)', () => {
      const routedAt = hoursAgo(1);
      const res = fastTrackFromHistory([
        { fromStatus: 'DRAFT', toStatus: 'PENDING_GIFSY', createdAt: routedAt, metadata: { fastTrack: KYC_FAST_TRACK_MARKER, previousSubmissionId: 'p' } },
      ]);
      expect(res).toEqual({ previousSubmissionId: 'p', previousRejectedAt: routedAt.toISOString() });
    });
  });

  describe('gifsyRejectionAfterManagers', () => {
    it('eligible only when the LATEST transition into the current rejected status came from PENDING_GIFSY', () => {
      const at = hoursAgo(5);
      expect(
        gifsyRejectionAfterManagers({ status: 'REJECTED' }, [{ fromStatus: 'PENDING_GIFSY', toStatus: 'REJECTED', createdAt: at }]),
      ).toEqual({ rejectedAt: at });
      expect(
        gifsyRejectionAfterManagers({ status: 'RE_UPLOAD_REQUIRED' }, [
          { fromStatus: 'PENDING_GIFSY', toStatus: 'RE_UPLOAD_REQUIRED', createdAt: at },
        ]),
      ).toEqual({ rejectedAt: at });
      // Manager / early-Gifsy rejection.
      expect(
        gifsyRejectionAfterManagers({ status: 'REJECTED' }, [{ fromStatus: 'PENDING_ASM_APPROVAL', toStatus: 'REJECTED', createdAt: at }]),
      ).toBeNull();
      // A row into a DIFFERENT rejected status does not count for the current one.
      expect(
        gifsyRejectionAfterManagers({ status: 'REJECTED' }, [{ fromStatus: 'PENDING_GIFSY', toStatus: 'RE_UPLOAD_REQUIRED', createdAt: at }]),
      ).toBeNull();
      // Not rejected at all / no prior / no history.
      expect(gifsyRejectionAfterManagers({ status: 'APPROVED' }, [])).toBeNull();
      expect(gifsyRejectionAfterManagers(null, [])).toBeNull();
      expect(gifsyRejectionAfterManagers({ status: 'REJECTED' }, [])).toBeNull();
    });
  });

  describe('gifsyRejectionAfterManagers — walks back through Gifsy re-acting on an already-rejected KYC (B3)', () => {
    const toGifsy = (h: number) => ({ fromStatus: 'PENDING_SO_APPROVAL', toStatus: 'PENDING_GIFSY', createdAt: hoursAgo(h) });

    it('PENDING_GIFSY→RE_UPLOAD_REQUIRED then RE_UPLOAD_REQUIRED→REJECTED via reject() → qualifies (latest rejection time)', () => {
      const latest = hoursAgo(2);
      expect(
        gifsyRejectionAfterManagers({ status: 'REJECTED' }, [
          toGifsy(10),
          { fromStatus: 'PENDING_GIFSY', toStatus: 'RE_UPLOAD_REQUIRED', createdAt: hoursAgo(5) },
          { fromStatus: 'RE_UPLOAD_REQUIRED', toStatus: 'REJECTED', createdAt: latest },
        ]),
      ).toEqual({ rejectedAt: latest });
    });

    it('PENDING_GIFSY→REJECTED then REJECTED→REJECTED via PATCH → qualifies; input order does not matter', () => {
      const latest = hoursAgo(1);
      expect(
        gifsyRejectionAfterManagers({ status: 'REJECTED' }, [
          { fromStatus: 'REJECTED', toStatus: 'REJECTED', createdAt: latest },
          { fromStatus: 'PENDING_GIFSY', toStatus: 'REJECTED', createdAt: hoursAgo(6) },
          toGifsy(9),
        ]),
      ).toEqual({ rejectedAt: latest });
    });

    it('a MANAGER rejection later re-rejected by Gifsy (REJECTED→REJECTED) does NOT qualify', () => {
      expect(
        gifsyRejectionAfterManagers({ status: 'REJECTED' }, [
          { fromStatus: 'PENDING_ASM_APPROVAL', toStatus: 'REJECTED', createdAt: hoursAgo(6) },
          { fromStatus: 'REJECTED', toStatus: 'REJECTED', createdAt: hoursAgo(1) },
        ]),
      ).toBeNull();
    });

    it('a manager-stage RE_UPLOAD_REQUIRED escalated to REJECTED by Gifsy does NOT qualify', () => {
      expect(
        gifsyRejectionAfterManagers({ status: 'REJECTED' }, [
          { fromStatus: 'PENDING_SO_APPROVAL', toStatus: 'RE_UPLOAD_REQUIRED', createdAt: hoursAgo(6) },
          { fromStatus: 'RE_UPLOAD_REQUIRED', toStatus: 'REJECTED', createdAt: hoursAgo(1) },
        ]),
      ).toBeNull();
    });

    it('an unprovable chain (no row into the rejected fromStatus) → null (fail safe)', () => {
      expect(
        gifsyRejectionAfterManagers({ status: 'REJECTED' }, [
          { fromStatus: 'RE_UPLOAD_REQUIRED', toStatus: 'REJECTED', createdAt: hoursAgo(1) },
        ]),
      ).toBeNull();
    });
  });

  it('kycRoutingLabel', () => {
    expect(kycRoutingLabel({ previousSubmissionId: 'a', previousRejectedAt: new Date().toISOString() })).toBe(
      'Direct to GIFSY (resubmitted after GIFSY rejection)',
    );
    expect(kycRoutingLabel(null)).toBe('');
    expect(kycRoutingLabel(undefined)).toBe('');
  });

  describe('loadKycFastTrackMap', () => {
    it('ONE narrow query for the whole set; no query for an empty set', async () => {
      const findMany = jest.fn().mockResolvedValue([
        { kycSubmissionId: 'a', fromStatus: 'DRAFT', toStatus: 'PENDING_GIFSY', createdAt: new Date(), metadata: ftMeta('x') },
      ]);
      const prisma = { kycStatusHistory: { findMany } } as never;
      const map = await loadKycFastTrackMap(prisma, ['a', 'b', 'a']);
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(findMany.mock.calls[0][0].where).toEqual({
        kycSubmissionId: { in: ['a', 'b'] },
        fromStatus: 'DRAFT',
        toStatus: 'PENDING_GIFSY',
      });
      expect(map.get('a')?.previousSubmissionId).toBe('x');
      expect(map.has('b')).toBe(false);

      findMany.mockClear();
      expect((await loadKycFastTrackMap(prisma, [])).size).toBe(0);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('tolerates a non-array result (never throws into a list endpoint)', async () => {
      const prisma = { kycStatusHistory: { findMany: jest.fn().mockResolvedValue(undefined) } } as never;
      expect((await loadKycFastTrackMap(prisma, ['a'])).size).toBe(0);
    });
  });
});

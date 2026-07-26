/// <reference types="vitest/globals" />
/**
 * TDD — lib/schemes.ts CANONICAL client (§13.4).
 *
 * The reward-era localStorage catalog (getPendingSchemes / seedAdminSchemes / …) is
 * RETIRED; these tests exercise the new typed client's URL/verb wiring, the media
 * view-path helpers, and the flagged legacy-compat shims. The api-client is mocked
 * so no network is touched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();

vi.mock('@/lib/api-client', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));

import { schemeApi, mediaViewUrl, rewriteMediaViewPath } from '../schemes';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  patch.mockReset();
  get.mockResolvedValue({ success: true, data: {} });
  post.mockResolvedValue({ success: true, data: {} });
  put.mockResolvedValue({ success: true, data: {} });
  patch.mockResolvedValue({ success: true, data: {} });
});

describe('schemeApi — admin authoring routes', () => {
  it('create → POST /api/schemes', () => {
    schemeApi.create({ code: 'C1', name: 'N', startDate: 'a', endDate: 'b' });
    expect(post).toHaveBeenCalledWith('/api/schemes', expect.objectContaining({ code: 'C1' }));
  });

  it('update → PATCH /api/schemes/:id', () => {
    schemeApi.update('s1', { name: 'X' });
    expect(patch).toHaveBeenCalledWith('/api/schemes/s1', { name: 'X' });
  });

  it('setStatus → PATCH /api/schemes/:id/status', () => {
    schemeApi.setStatus('s1', 'ACTIVE');
    expect(patch).toHaveBeenCalledWith('/api/schemes/s1/status', { status: 'ACTIVE' });
  });

  it('upsertEnrollmentForm → PUT /api/schemes/:id/enrollment-form', () => {
    schemeApi.upsertEnrollmentForm('s1', {
      campaignType: 'OPEN_CAMPAIGN',
      formSchema: { captureGpsOnSubmit: false, requireOtp: false, fields: [] },
    });
    expect(put).toHaveBeenCalledWith(
      '/api/schemes/s1/enrollment-form',
      expect.objectContaining({ campaignType: 'OPEN_CAMPAIGN' }),
    );
  });

  it('setAudience → POST /api/schemes/:id/audience', () => {
    schemeApi.setAudience('s1', { mode: 'FILTER', selfEnrollAllowed: true, frozen: false });
    expect(post).toHaveBeenCalledWith('/api/schemes/s1/audience', expect.objectContaining({ mode: 'FILTER' }));
  });

  it('getRoster → GET with pagination query', () => {
    schemeApi.getRoster('s1', { page: 2, limit: 25 });
    expect(get).toHaveBeenCalledWith('/api/schemes/s1/roster?page=2&limit=25');
  });

  it('listEnrollments → GET with filter query (drops empty)', () => {
    schemeApi.listEnrollments('s1', { status: 'SUBMITTED', zone: '', page: 1 });
    expect(get).toHaveBeenCalledWith('/api/schemes/s1/enrollments?status=SUBMITTED&page=1');
  });

  it('getEnrollment → GET /api/schemes/:id/enrollments/:enrollmentId', () => {
    schemeApi.getEnrollment('s1', 'e1');
    expect(get).toHaveBeenCalledWith('/api/schemes/s1/enrollments/e1');
  });

  it('reject → POST .../reject with reason', () => {
    schemeApi.reject('s1', 'e1', 'blurry photo');
    expect(post).toHaveBeenCalledWith('/api/schemes/s1/enrollments/e1/reject', { reason: 'blurry photo' });
  });
});

describe('schemeApi — notifications + reports', () => {
  it('broadcast → POST /api/schemes/:id/broadcast', () => {
    schemeApi.broadcast('s1', { channel: 'WHATSAPP', templateId: 't', recipientScope: 'BOTH' });
    expect(post).toHaveBeenCalledWith('/api/schemes/s1/broadcast', expect.objectContaining({ channel: 'WHATSAPP' }));
  });
  it('listBroadcasts → GET /api/schemes/:id/broadcasts', () => {
    schemeApi.listBroadcasts('s1');
    expect(get).toHaveBeenCalledWith('/api/schemes/s1/broadcasts');
  });
  it('getReport / getTenantReport', () => {
    schemeApi.getReport('s1');
    schemeApi.getTenantReport('s1');
    expect(get).toHaveBeenCalledWith('/api/schemes/s1/report');
    expect(get).toHaveBeenCalledWith('/api/schemes/s1/report/tenant');
  });
  it('exportUrl builds the auth-gated export path', () => {
    expect(schemeApi.exportUrl('s1')).toBe('/api/schemes/s1/report/export');
  });
});

describe('schemeApi — enrollee routes', () => {
  it('listEligible → GET /api/schemes/enroll/eligible', () => {
    schemeApi.listEligible();
    expect(get).toHaveBeenCalledWith('/api/schemes/enroll/eligible');
  });
  it('listSalesEligible → GET /api/schemes/sales/eligible', () => {
    schemeApi.listSalesEligible();
    expect(get).toHaveBeenCalledWith('/api/schemes/sales/eligible');
  });
  it('getSalesTargets → GET /api/schemes/:id/sales-targets (drops empty query)', () => {
    schemeApi.getSalesTargets('s1');
    expect(get).toHaveBeenCalledWith('/api/schemes/s1/sales-targets');
  });
  it('getSalesTargets → GET with a status + pagination query', () => {
    schemeApi.getSalesTargets('s1', { status: 'REJECTED', page: 2, limit: 25 });
    expect(get).toHaveBeenCalledWith('/api/schemes/s1/sales-targets?status=REJECTED&page=2&limit=25');
  });
  it('getMyEnrollment → GET /api/schemes/:id/enrollment', () => {
    schemeApi.getMyEnrollment('s1');
    expect(get).toHaveBeenCalledWith('/api/schemes/s1/enrollment');
  });
  it('sendOtp / verifyOtp → POST enrollment/otp-*', () => {
    schemeApi.sendOtp('s1', { enrollmentMode: 'SELF', mobile: '9999900000' });
    schemeApi.verifyOtp('s1', { enrollmentMode: 'SELF', mobile: '9999900000', otp: '1234' });
    expect(post).toHaveBeenCalledWith('/api/schemes/s1/enrollment/otp-send', expect.any(Object));
    expect(post).toHaveBeenCalledWith('/api/schemes/s1/enrollment/otp-verify', expect.objectContaining({ otp: '1234' }));
  });
  it('enroll → POST /api/schemes/:id/enrollment', () => {
    schemeApi.enroll('s1', { enrollmentMode: 'SALES', targetOutletRef: 'o1', formValues: { f: 1 } });
    expect(post).toHaveBeenCalledWith(
      '/api/schemes/s1/enrollment',
      expect.objectContaining({ enrollmentMode: 'SALES', targetOutletRef: 'o1' }),
    );
  });
  it('resubmit → POST .../resubmit', () => {
    schemeApi.resubmit('s1', 'e1', { formValues: {} });
    expect(post).toHaveBeenCalledWith('/api/schemes/s1/enrollments/e1/resubmit', expect.any(Object));
  });
});

describe('media view-path helpers (D30)', () => {
  it('mediaViewUrl builds an /api auth-gated URL with encoded key', () => {
    expect(mediaViewUrl('s1', 'scheme-media/c/abc def')).toBe(
      '/api/schemes/s1/enrollments/media?key=scheme-media%2Fc%2Fabc%20def',
    );
  });
  it('rewriteMediaViewPath maps a backend /v1 path to /api', () => {
    expect(rewriteMediaViewPath('/v1/schemes/s1/enrollments/media?key=k')).toBe(
      '/api/schemes/s1/enrollments/media?key=k',
    );
  });
});

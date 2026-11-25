/// <reference types="vitest/globals" />
/**
 * fetchVisibilityCaptureMode — a failed read is 'UNKNOWN', never a guessed PHOTO_APPROVAL (owner rule: no silent
 * fallback). A features blob without the field is PHOTO_APPROVAL (the backend default).
 * Run: npx vitest run src/lib/__tests__/visibility-capture-mode.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchVisibilityCaptureMode } from '../visibility-capture-mode';

const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());

describe('fetchVisibilityCaptureMode', () => {
  it.each([
    ['AMOUNT_UPLOAD stored', () => Promise.resolve(res({ success: true, data: { features: { visibilityCaptureMode: 'AMOUNT_UPLOAD' } } })), 'AMOUNT_UPLOAD'],
    ['PHOTO_APPROVAL stored', () => Promise.resolve(res({ success: true, data: { features: { visibilityCaptureMode: 'PHOTO_APPROVAL' } } })), 'PHOTO_APPROVAL'],
    ['field absent (backend default)', () => Promise.resolve(res({ success: true, data: { features: {} } })), 'PHOTO_APPROVAL'],
    ['network error', () => Promise.reject(new Error('offline')), 'UNKNOWN'],
    ['HTTP 500', () => Promise.resolve(res({ success: false, error: 'boom' }, 500)), 'UNKNOWN'],
    ['HTTP 403', () => Promise.resolve(res({ success: false, error: 'no' }, 403)), 'UNKNOWN'],
    ['no features in the body', () => Promise.resolve(res({ success: true, data: {} })), 'UNKNOWN'],
    ['unreadable body', () => Promise.resolve(new Response('<html>', { status: 200 })), 'UNKNOWN'],
    ['unrecognised stored value', () => Promise.resolve(res({ success: true, data: { features: { visibilityCaptureMode: 'BOTH' } } })), 'UNKNOWN'],
  ])('%s → %s', async (_n, impl, expected) => {
    const f = vi.fn(impl);
    vi.stubGlobal('fetch', f);
    expect(await fetchVisibilityCaptureMode()).toBe(expected);
    expect(f).toHaveBeenCalledWith('/api/admin/settings/features', expect.anything());
  });
});

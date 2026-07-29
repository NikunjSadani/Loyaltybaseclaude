/**
 * Unit tests for the platformWide / tenantScope helper (cross-tenant read boundary).
 * The matrix that matters: a GIFSY operator is platform-wide ONLY when NOT assumed into
 * a tenant; once assumed (`assumed:true`) it is pinned to its clientId like any tenant user.
 * Run: npx jest src/common/tenant-scope.spec.ts
 */
import { platformWide, tenantScope } from './tenant-scope';
import { JwtPayload } from './decorators/current-user.decorator';

const base = { sub: 'u', phone: '9', name: 'N' };

const unassumedGifsy: JwtPayload = { ...base, role: 'GIFSY_ADMIN', clientId: 'gifsy' };
const assumedGifsy: JwtPayload = { ...base, role: 'GIFSY_ADMIN', clientId: 'deoleo', assumed: true };
const clientAdmin: JwtPayload = { ...base, role: 'CLIENT_ADMIN', clientId: 'deoleo' };
// A non-admin tenant user that somehow carried an assumed flag must still be pinned.
const salesUser: JwtPayload = { ...base, role: 'SALES_SO', clientId: 'deoleo' };

describe('platformWide', () => {
  it('is TRUE for an un-assumed GIFSY_ADMIN (assumed absent)', () => {
    expect(platformWide(unassumedGifsy)).toBe(true);
  });

  it('is FALSE for an ASSUMED GIFSY_ADMIN (assumed:true)', () => {
    expect(platformWide(assumedGifsy)).toBe(false);
  });

  it('is FALSE for a CLIENT_ADMIN', () => {
    expect(platformWide(clientAdmin)).toBe(false);
  });

  it('is FALSE for a non-admin tenant user', () => {
    expect(platformWide(salesUser)).toBe(false);
  });

  it('treats assumed:false the same as un-assumed for a GIFSY_ADMIN', () => {
    expect(platformWide({ ...unassumedGifsy, assumed: false })).toBe(true);
  });
});

describe('tenantScope', () => {
  it('returns undefined (platform-wide) for an un-assumed GIFSY_ADMIN', () => {
    expect(tenantScope(unassumedGifsy)).toBeUndefined();
  });

  it('returns the assumed clientId for an ASSUMED GIFSY_ADMIN', () => {
    expect(tenantScope(assumedGifsy)).toBe('deoleo');
  });

  it('returns the own clientId for a CLIENT_ADMIN', () => {
    expect(tenantScope(clientAdmin)).toBe('deoleo');
  });
});

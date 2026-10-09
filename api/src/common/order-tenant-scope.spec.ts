import { orderTenantScopeWhere } from './order-tenant-scope';

describe('orderTenantScopeWhere (Employee Rewards Phase B — EMP-GAP-1)', () => {
  it('returns {} for a platform-wide caller (undefined scope) — no tenant filter at all', () => {
    expect(orderTenantScopeWhere(undefined)).toEqual({});
  });

  it('spans BOTH owner shapes for a scoped caller: trade (partner) OR employee (account)', () => {
    expect(orderTenantScopeWhere('deoleo')).toEqual({
      OR: [{ partner: { clientId: 'deoleo' } }, { account: { clientId: 'deoleo' } }],
    });
  });

  it('never emits a top-level partner key (would drop null-partner employee orders)', () => {
    const w = orderTenantScopeWhere('britannia') as { partner?: unknown; OR?: unknown };
    expect(w.partner).toBeUndefined();
    expect(Array.isArray(w.OR)).toBe(true);
  });
});

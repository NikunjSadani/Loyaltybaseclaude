import { describe, it, expect } from 'vitest';
import {
  buildLevelRows,
  mapRoleCodeToUserRole,
  resolveReportingLinks,
  syntheticPlaceholderPhone,
} from '@/lib/hierarchy-persistence';
import { DEOLEO_HIERARCHY } from '@/lib/employee-hierarchy';
import type { HierarchyEmployee } from '@/types';

// Helper: minimal employee for link resolution
const emp = (id: string, reportsToId: string | null): Pick<HierarchyEmployee, 'id' | 'reportsToId'> =>
  ({ id, reportsToId });

describe('buildLevelRows', () => {
  it('produces one row per config level, sorted leaf→root', () => {
    const rows = buildLevelRows(DEOLEO_HIERARCHY);
    expect(rows.map((r) => r.code)).toEqual(['XSR', 'SO', 'ASM', 'RSM', 'ZNM', 'NSM']);
    expect(rows.map((r) => r.level)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('carries the role label as the level name', () => {
    const rows = buildLevelRows([
      { tenantId: 't', level: 1, roleCode: 'XSR', roleLabel: 'Field Rep', isLeaf: true, isRoot: false },
    ]);
    expect(rows[0]).toEqual({ code: 'XSR', name: 'Field Rep', level: 1 });
  });
});

describe('mapRoleCodeToUserRole', () => {
  it('maps each fine role to its coarse UserRole bucket', () => {
    expect(mapRoleCodeToUserRole('NSM')).toBe('SALES_HO');
    expect(mapRoleCodeToUserRole('RSM')).toBe('SALES_STATE_HEAD');
    expect(mapRoleCodeToUserRole('ASM')).toBe('SALES_ASM');
    expect(mapRoleCodeToUserRole('SO')).toBe('SALES_SO');
    expect(mapRoleCodeToUserRole('XSR')).toBe('SALES_ISR');
  });

  it('buckets ZNM onto SALES_STATE_HEAD (no ZNM enum value)', () => {
    expect(mapRoleCodeToUserRole('ZNM')).toBe('SALES_STATE_HEAD');
  });

  it('is case-insensitive and trims', () => {
    expect(mapRoleCodeToUserRole('  nsm ')).toBe('SALES_HO');
  });

  it('falls back to the leaf field role for an unknown code', () => {
    expect(mapRoleCodeToUserRole('WHATEVER')).toBe('SALES_ISR');
  });
});

describe('resolveReportingLinks', () => {
  it('resolves a valid full chain XSR→SO→ASM→NSM', () => {
    const links = resolveReportingLinks([
      emp('NSM-1', null),
      emp('ASM-1', 'NSM-1'),
      emp('SO-1', 'ASM-1'),
      emp('XSR-1', 'SO-1'),
    ]);
    const byCode = Object.fromEntries(links.map((l) => [l.employeeCode, l.managerEmployeeCode]));
    expect(byCode).toEqual({
      'NSM-1': null,
      'ASM-1': 'NSM-1',
      'SO-1': 'ASM-1',
      'XSR-1': 'SO-1',
    });
  });

  it('resolves a manager defined LATER in the list (order-independent)', () => {
    const links = resolveReportingLinks([
      emp('XSR-1', 'SO-1'), // manager appears after
      emp('SO-1', null),
    ]);
    const xsr = links.find((l) => l.employeeCode === 'XSR-1');
    expect(xsr?.managerEmployeeCode).toBe('SO-1');
  });

  it('leaves the manager null when the referenced manager is missing from the list', () => {
    const links = resolveReportingLinks([emp('XSR-1', 'SO-GHOST')]);
    expect(links[0].managerEmployeeCode).toBeNull();
  });

  it('treats a root (no manager) as a null link', () => {
    const links = resolveReportingLinks([emp('NSM-1', null)]);
    expect(links[0].managerEmployeeCode).toBeNull();
  });

  it('includes placeholder positions in the links (they still hold a slot in the tree)', () => {
    const links = resolveReportingLinks([
      emp('SO-1', null),
      emp('XSR-VAC', 'SO-1'), // a placeholder XSR
    ]);
    const vac = links.find((l) => l.employeeCode === 'XSR-VAC');
    expect(vac?.managerEmployeeCode).toBe('SO-1');
  });
});

describe('syntheticPlaceholderPhone', () => {
  it('is deterministic and non-numeric so it never collides with a real 10-digit phone', () => {
    const p = syntheticPlaceholderPhone('XSR-VAC');
    expect(p).toBe(syntheticPlaceholderPhone('XSR-VAC'));
    expect(/^\d{10}$/.test(p)).toBe(false);
  });

  it('is unique per employee code', () => {
    expect(syntheticPlaceholderPhone('A')).not.toBe(syntheticPlaceholderPhone('B'));
  });
});

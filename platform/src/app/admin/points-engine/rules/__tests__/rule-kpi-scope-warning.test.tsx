/// <reference types="vitest/globals" />
/**
 * APPLIES-TO D5 — RuleBuilder's non-blocking warning when the rule's audience (attachment program / sub-program AND
 * hard segmentFilter nodes on outlet type / program / sub-program — same as the backend `ruleAppliesTo`) lies outside
 * its KPI's scope. Disjoint → the backend refuses to publish; partial → those outlets are skipped in compute.
 * Case-only spelling is left to the server (it checks the LIVE outlet spellings, which the builder does not have).
 * Run: npx vitest run src/app/admin/points-engine/rules/__tests__/rule-kpi-scope-warning.test.tsx
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ruleKpiScopeWarning } from '../_components/RuleBuilder';
import { ruleScopeOf } from '@/lib/kpi-scope-core';

const scope = (o: Partial<{ outletTypes: string[]; programs: string[]; subPrograms: string[] }>) => ({
  outletTypes: [], programs: [], subPrograms: [], ...o,
});
const hard = (field: string, allow: string[]) => ({ type: 'segmentFilter', id: 's', field, allow, onFail: 'zero' });
const soft = (field: string, allow: string[]) => ({ type: 'segmentFilter', id: 's', field, allow, onFail: 'skipNode' });

describe('ruleKpiScopeWarning', () => {
  it('no warning: unknown KPI, unscoped KPI, "any" program, or an exactly-spelled (trimmed) program', () => {
    expect(ruleKpiScopeWarning('K', undefined, { program: 'X' })).toBeNull();
    expect(ruleKpiScopeWarning('K', scope({}), { program: 'X' })).toBeNull();
    expect(ruleKpiScopeWarning('K', scope({ programs: ['Unnati'] }), { program: null })).toBeNull();
    expect(ruleKpiScopeWarning('K', scope({ programs: ['Unnati'] }), { program: ' Unnati ' })).toBeNull();
    // outlet-type-only KPI scope + a rule with no outlet-type filter → no conflict
    expect(ruleKpiScopeWarning('K', scope({ outletTypes: ['SSS'] }), { program: 'Unnati' })).toBeNull();
  });

  it('warns for a program and/or sub-program outside the KPI scope, naming both sides', () => {
    const w = ruleKpiScopeWarning('UNNATI_VOL', scope({ programs: ['Unnati'], subPrograms: ['Lite'] }), {
      program: 'Pragati', programCategory: 'Lite',
    });
    expect(w).toMatch(/KPI UNNATI_VOL does not apply to this rule's program "Pragati" \(the KPI applies only to Unnati\)/);
    expect(w).toMatch(/publishing will be refused/);
    const both = ruleKpiScopeWarning('K', scope({ programs: ['Unnati'], subPrograms: ['Lite'] }), {
      program: 'Pragati', programCategory: 'Max',
    });
    expect(both).toMatch(/program "Pragati".* or sub-program "Max"/);
  });

  it('audit #4: NO case-only hint — a ci-equal value overlaps; the server names the LIVE outlet spelling', () => {
    expect(ruleKpiScopeWarning('RLP_VOL', scope({ programs: ['RLP'] }), { program: 'rlp' })).toBeNull();
    expect(ruleKpiScopeWarning('K', scope({ subPrograms: ['Tier A'] }), { program: null, programCategory: 'tier a' })).toBeNull();
  });

  describe('audit #5: HARD segmentFilter nodes count (like the backend ruleAppliesTo)', () => {
    it('a hard outletType filter disjoint from the KPI types → refused-publish warning', () => {
      const w = ruleKpiScopeWarning('K', scope({ outletTypes: ['SSS'] }), {
        program: null, pipeline: [hard('outletType', ['WHOLESALER'])],
      });
      expect(w).toMatch(/outlet type "WHOLESALER" \(the KPI applies only to SSS\)/);
      expect(w).toMatch(/publishing will be refused/);
    });

    it('a hard program filter narrows an any-program rule; a hard programCategory filter counts too', () => {
      expect(
        ruleKpiScopeWarning('K', scope({ programs: ['Gold'] }), { program: null, pipeline: [hard('program', ['Silver'])] }),
      ).toMatch(/program "Silver".*publishing will be refused/);
      expect(
        ruleKpiScopeWarning('K', scope({ subPrograms: ['Urban'] }), { program: null, pipeline: [hard('programCategory', ['Rural'])] }),
      ).toMatch(/sub-program "Rural"/);
    });

    it('a SOFT filter restricts nothing → no warning', () => {
      expect(
        ruleKpiScopeWarning('K', scope({ outletTypes: ['SSS'] }), { program: null, pipeline: [soft('outletType', ['WHOLESALER'])] }),
      ).toBeNull();
    });

    it('PARTIAL overlap (hard filter allows SSS + WHOLESALER, KPI only SSS) → skip warning, NOT refused', () => {
      const w = ruleKpiScopeWarning('K', scope({ outletTypes: ['SSS'] }), {
        program: null, pipeline: [hard('outletType', ['sss', 'WHOLESALER'])],
      });
      expect(w).toMatch(/outlet type "WHOLESALER"/);
      expect(w).toMatch(/skipped in compute; the rest can earn/);
      expect(w).not.toMatch(/refused/);
    });
  });

  it('ruleScopeOf mirrors the backend: attachment ∩ hard filters; a self-contradictory filter is skipped', () => {
    expect(ruleScopeOf({ program: 'Gold', pipeline: [hard('program', ['gold', 'Silver'])] })).toEqual(scope({ programs: ['Gold'] }));
    expect(ruleScopeOf({ program: 'Gold', pipeline: [hard('program', ['Silver'])] })).toEqual(scope({ programs: ['Gold'] }));
    expect(ruleScopeOf({ program: null, pipeline: [hard(' OutletType ', ['sss']), hard('metro', ['Y'])] })).toEqual(
      scope({ outletTypes: ['SSS'] }),
    );
  });
});

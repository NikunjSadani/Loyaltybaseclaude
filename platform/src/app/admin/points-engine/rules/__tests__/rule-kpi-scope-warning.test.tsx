/// <reference types="vitest/globals" />
/**
 * APPLIES-TO D5 — RuleBuilder's non-blocking warning when the rule's program / sub-program lies outside its KPI's
 * scope (the backend SKIPs those outlets in compute and refuses to publish a disjoint rule).
 * Run: npx vitest run src/app/admin/points-engine/rules/__tests__/rule-kpi-scope-warning.test.tsx
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ruleKpiScopeWarning } from '../_components/RuleBuilder';

const scope = (o: Partial<{ outletTypes: string[]; programs: string[]; subPrograms: string[] }>) => ({
  outletTypes: [], programs: [], subPrograms: [], ...o,
});

describe('ruleKpiScopeWarning', () => {
  it('no warning: unknown KPI, unscoped KPI, "any" program, or an overlapping (ci) program', () => {
    expect(ruleKpiScopeWarning('K', undefined, { program: 'X' })).toBeNull();
    expect(ruleKpiScopeWarning('K', scope({}), { program: 'X' })).toBeNull();
    expect(ruleKpiScopeWarning('K', scope({ programs: ['Unnati'] }), { program: null })).toBeNull();
    expect(ruleKpiScopeWarning('K', scope({ programs: ['Unnati'] }), { program: ' unnati ' })).toBeNull();
    // outlet-type-only KPI scope never conflicts with a rule (rules attach by program / sub-program only)
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
});

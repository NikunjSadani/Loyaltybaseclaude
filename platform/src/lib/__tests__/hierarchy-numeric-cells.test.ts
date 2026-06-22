import { describe, it, expect } from 'vitest';
import { DEOLEO_HIERARCHY, parseHierarchyChainRows } from '@/lib/employee-hierarchy';

/**
 * UAT regression: "Could not read the file: (raw[...] ?? '').trim is not a function".
 * SheetJS returns NUMBERS for numeric cells (phones / numeric IDs). The parser read cells with
 * `(raw[col] ?? '').trim()` — `?? ''` keeps a number, and numbers have no `.trim()`, so the whole
 * upload threw. The fix coerces with String() before trimming. This passes a numeric cell straight
 * into the real parser, so it fails without the fix and passes with it — independent of the bundle.
 */
describe('hierarchy chain parse — numeric cells (UAT regression)', () => {
  const numericRow: Record<string, unknown> = {
    'XSR ID': 123, 'XSR Name': 'Anil', 'XSR Phone': 9900000041,          // numbers, not strings
    'SO ID': 'SO1', 'SO Name': 'SO Mgr', 'SO Phone': 9900000002,
    'ASM ID': 'ASM1', 'ASM Name': 'ASM Mgr', 'ASM Phone': '9900000003',
    'RSM ID': 'RSM1', 'RSM Name': 'RSM Mgr', 'RSM Phone': '9900000004',
    'ZNM ID': 'ZNM1', 'ZNM Name': 'ZNM Mgr', 'ZNM Phone': '9900000005',
    'NSM ID': 'NSM1', 'NSM Name': 'NSM Mgr', 'NSM Phone': '9900000006',
  };

  it('does not throw on numeric cells and coerces them to strings', () => {
    expect(() =>
      parseHierarchyChainRows([numericRow] as Record<string, string>[], DEOLEO_HIERARCHY),
    ).not.toThrow();

    const result = parseHierarchyChainRows([numericRow] as Record<string, string>[], DEOLEO_HIERARCHY);
    const ids = result.employeeRows.map((e) => e.employeeId);
    expect(ids).toContain('123');           // numeric XSR ID stringified
    const phones = result.employeeRows.map((e) => e.employeePhone);
    expect(phones).toContain('9900000041'); // numeric XSR phone stringified
  });
});

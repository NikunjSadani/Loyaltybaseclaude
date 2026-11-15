import { capUploadResult } from './tds.helpers';

/** Memory-safety (2026-11-13): TDS upload responses cap their error/warning lists at 500. */
describe('capUploadResult', () => {
  const err = (row: number) => ({ row, message: `bad ${row}` });

  it('leaves a small result intact and reports nothing truncated', () => {
    const out = capUploadResult({ processed: 2, succeeded: 1, skipped: 0, failed: 1, errors: [err(2)] });
    expect(out).toEqual({ processed: 2, succeeded: 1, skipped: 0, failed: 1, errors: [err(2)], errorsTruncated: false });
  });

  it('caps errors and warnings at 500 with the true totals', () => {
    const errors = Array.from({ length: 600 }, (_, i) => err(i + 2));
    const warnings = Array.from({ length: 501 }, (_, i) => err(i + 2));
    const out = capUploadResult({ processed: 1200, succeeded: 600, skipped: 0, failed: 600, errors, warnings });
    expect(out.errors).toHaveLength(500);
    expect(out.errorsTruncated).toBe(true);
    expect(out.failed).toBe(600);
    expect(out.warnings).toHaveLength(500);
    expect(out.warningCount).toBe(501);
    expect(out.warningsTruncated).toBe(true);
  });
});

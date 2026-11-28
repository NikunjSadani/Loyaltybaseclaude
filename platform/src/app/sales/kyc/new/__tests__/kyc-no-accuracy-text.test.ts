/// <reference types="vitest/globals" />
/**
 * NOACC — owner 2026-11-28: rep-facing capture screens show NOTHING about the phone's GPS accuracy (reps read
 * "±13m" as their distance from the outlet). Location is still captured and submitted exactly as before.
 *
 * A source guard over every rep-facing capture surface (the KYC wizard renders its board-photo / payment geo deep
 * in a multi-step flow; the visibility + scheme renderers are also covered by render tests): no "±" figure and no
 * `.accuracy` value interpolated into the UI. Admin / review screens and exports are deliberately NOT in this list —
 * reviewers still see accuracy there.
 *
 * NOACC1: the KYC wizard renders no ±accuracy (board photo + payment geo lines)
 * NOACC2: the visibility capture form / sheet and the scheme form renderer render no ±accuracy
 * NOACC3: the KYC wizard still records the accuracy it sends (capture unchanged — display only)
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const SRC = resolve(__dirname, '../../../../..');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

const REP_FACING = [
  'app/sales/kyc/new/page.tsx',
  'components/visibility/VisibilityCaptureForm.tsx',
  'app/sales/visibility/VisibilityCaptureSheet.tsx',
  'components/schemes/SchemeFormRenderer.tsx',
];

/** Source lines minus comments (a comment may explain the ± rule). */
function codeLines(src: string): string[] {
  return src
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .filter((l) => !/^\s*(\*|\/\*)/.test(l));
}

describe('NOACC — no phone accuracy on rep-facing capture screens', () => {
  it('NOACC1: KYC wizard has no ± figure and no rendered {…accuracy}m', () => {
    const lines = codeLines(read('app/sales/kyc/new/page.tsx'));
    expect(lines.filter((l) => l.includes('±'))).toEqual([]);
    expect(lines.filter((l) => /\{[^}]*[Gg]eo\.accuracy\}\s*m/.test(l))).toEqual([]);
  });

  it.each(REP_FACING)('NOACC2: %s renders no ± figure', (rel) => {
    expect(codeLines(read(rel)).filter((l) => l.includes('±'))).toEqual([]);
  });

  it('NOACC3: the KYC wizard still captures + sends the fix accuracy (recording unchanged)', () => {
    const src = read('app/sales/kyc/new/page.tsx');
    expect(src).toMatch(/accuracy: Math\.round\(pos\.coords\.accuracy\)/);
  });
});

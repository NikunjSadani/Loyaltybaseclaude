/**
 * Pins the console's ticket-remarks email rule to the API's (api/src/tickets/ticket-remarks-inbox.ts):
 * the regex / limit SOURCE must be identical, and the same table of cases must agree.
 * Run: npx vitest run src/lib/__tests__/ticket-remarks-email-rule.test.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { EMAIL_RE, INVISIBLE_RE, MAX_LEN, checkRemarksEmail } from '../ticket-remarks-email-rule';

const apiFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../api/src/tickets/ticket-remarks-inbox.ts');

describe('ticket remarks email rule — console mirrors the API exactly', () => {
  const api = readFileSync(apiFile, 'utf8');

  it('EMAIL_RE, INVISIBLE_RE and MAX_LEN are byte-identical to the API source', () => {
    expect(api).toContain(`export const EMAIL_RE = ${EMAIL_RE.toString()};`);
    expect(api).toContain(`export const INVISIBLE_RE = ${INVISIBLE_RE.toString()};`);
    expect(api).toContain(`export const MAX_LEN = ${MAX_LEN};`);
  });

  it.each([
    ['support+tickets@bajaj.example', true],
    ["o'neil@mail.bajaj-consumer.co.in", true],
    [' Tickets@Bajaj.Example ', true],
    ['a@b', false],
    ['tickets@-bajaj.example', false],
    ['tickéts@bajaj.example', false],
    ['tickets​@bajaj.example', false],
    ['<tickets@bajaj.example>', false],
    [`${'a'.repeat(250)}@b.com`, false],
  ])('%j → valid=%s', (raw, ok) => {
    const r = checkRemarksEmail(raw);
    expect('email' in r).toBe(ok);
  });
});

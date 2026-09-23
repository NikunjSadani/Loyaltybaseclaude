/**
 * RosterRemoveUploadDto through the REAL production ValidationPipe.
 *
 * This is the runtime guard for the "boolean DTO + enableImplicitConversion = fail-open"
 * trap: the roster bulk-remove `dryRun` MUST reach the service as the verbatim STRING the
 * client sent, NOT a truthiness-coerced boolean. If `dryRun` is ever re-typed `boolean`,
 * `enableImplicitConversion` would coerce 'false' -> true and this spec fails — which is the
 * whole point (unit tests that call the service directly bypass the pipe and can't catch it).
 *
 * Run: npx jest src/schemes/dto/roster-remove-upload.dto.spec.ts
 */
import { ValidationPipe, BadRequestException, ArgumentMetadata } from '@nestjs/common';
import { RosterRemoveUploadDto } from './scheme-admin.dto';

// EXACT options from api/src/main.ts
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const meta: ArgumentMetadata = { type: 'body', metatype: RosterRemoveUploadDto, data: '' };

// The service's interpretation (safe preview default): only an explicit 'false'/'0' writes.
const wouldPerformRemoval = (v: unknown) => v !== 'false' && v !== '0' ? false : true;

describe('RosterRemoveUploadDto via production ValidationPipe', () => {
  it("dryRun:'false' survives as the string 'false' (NOT coerced to boolean true) → performs removal", async () => {
    const out = await pipe.transform({ dryRun: 'false' }, meta);
    expect(out.dryRun).toBe('false');
    expect(typeof out.dryRun).toBe('string');
    expect(wouldPerformRemoval(out.dryRun)).toBe(true);
  });

  it("dryRun:'0' survives as '0' → performs removal", async () => {
    const out = await pipe.transform({ dryRun: '0' }, meta);
    expect(out.dryRun).toBe('0');
    expect(wouldPerformRemoval(out.dryRun)).toBe(true);
  });

  it("dryRun:'true' → preview (no writes)", async () => {
    const out = await pipe.transform({ dryRun: 'true' }, meta);
    expect(out.dryRun).toBe('true');
    expect(wouldPerformRemoval(out.dryRun)).toBe(false);
  });

  it('omitted dryRun → undefined → preview (safe default, never an unconfirmed removal)', async () => {
    const out = await pipe.transform({}, meta);
    expect(out.dryRun).toBeUndefined();
    expect(wouldPerformRemoval(out.dryRun)).toBe(false);
  });

  it('rejects an out-of-set value (400) instead of silently coercing', async () => {
    await expect(pipe.transform({ dryRun: 'xyz' }, meta)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes through an idColumn override untouched', async () => {
    const out = await pipe.transform({ idColumn: 'outlet_code', dryRun: 'false' }, meta);
    expect(out.idColumn).toBe('outlet_code');
    expect(out.dryRun).toBe('false');
  });
});

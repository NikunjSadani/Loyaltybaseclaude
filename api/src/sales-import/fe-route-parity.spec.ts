import { readFileSync } from 'fs';
import { join } from 'path';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { SalesImportConfigController } from './sales-import-config.controller';
import { SalesImportApplyController } from './sales-import-apply.controller';
import { SalesImportController } from './sales-import.controller';
import { SalesMonthsController } from './sales-months.controller';
import { SalesImportDrainController } from './sales-import-drain.controller';

/**
 * FE ↔ BE route parity (Phase 2 integration). Every call the frontend makes in `platform/src/lib/sales-import/api.ts`
 * and `upload.ts` must hit a real backend handler (method + path), and every admin handler must be reachable from the
 * FE. Param names are normalised (`:id`, `${id(x)}` → `:p`); query strings are ignored (checked by type parity).
 */
const FE_DIR = join(__dirname, '..', '..', '..', 'platform', 'src', 'lib', 'sales-import');
const norm = (p: string) =>
  ('/' + p)
    .replace(/\/+/g, '/')
    .replace(/\/:[^/]+/g, '/:p')
    .replace(/\/$/, '');

function backendRoutes(): Set<string> {
  const out = new Set<string>();
  for (const c of [SalesImportConfigController, SalesImportApplyController, SalesImportController, SalesMonthsController, SalesImportDrainController]) {
    const base: string = Reflect.getMetadata(PATH_METADATA, c);
    for (const name of Object.getOwnPropertyNames(c.prototype)) {
      if (name === 'constructor') continue;
      const fn = (c.prototype as unknown as Record<string, unknown>)[name];
      if (typeof fn !== 'function') continue;
      const path: string | undefined = Reflect.getMetadata(PATH_METADATA, fn);
      const method: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, fn);
      if (path === undefined || method === undefined) continue;
      out.add(`${RequestMethod[method]} ${norm(`${base}/${path === '/' ? '' : path}`)}`);
    }
  }
  return out;
}

function frontendRoutes(): Set<string> {
  const out = new Set<string>();
  const verb: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', del: 'DELETE' };
  const toPath = (raw: string) => {
    let s = raw.replace(/\$\{BASE\}/g, '/api/admin/sales-import').replace(/\$\{MONTHS\}/g, '/api/admin/sales-months');
    const q = s.indexOf('?');
    if (q >= 0) s = s.slice(0, q);
    const open = s.lastIndexOf('${');
    if (open >= 0 && s.indexOf('}', open) < 0) s = s.slice(0, open); // an unclosed `${qs ? ` tail
    s = s.replace(/\$\{[^}]*\}/g, ':p');
    if (!s.startsWith('/api/')) throw new Error(`unexpected FE url ${raw}`);
    return norm(s.slice('/api/'.length));
  };
  for (const file of ['api.ts', 'upload.ts']) {
    const src = readFileSync(join(FE_DIR, file), 'utf8');
    for (const m of src.matchAll(/api\.(get|post|put|patch|del)<.*?>\(\s*[`'"]([^`'"]+)[`'"]/g)) out.add(`${verb[m[1]]} ${toPath(m[2])}`);
    for (const m of src.matchAll(/fetch\(\s*`([^`]+)`\s*,\s*\{\s*method:\s*'([A-Z]+)'/g)) out.add(`${m[2]} ${toPath(m[1])}`);
    // Download URL builders (fetched with GET by fetchDownload).
    for (const m of src.matchAll(/Url:\s*\([^)]*\)\s*=>\s*`([^`]+)`/g)) out.add(`GET ${toPath(m[1])}`);
  }
  return out;
}

describe('sales-import FE ↔ BE route parity', () => {
  const be = backendRoutes();
  const fe = frontendRoutes();

  it('found a sane number of routes on both sides', () => {
    expect(be.size).toBeGreaterThanOrEqual(20);
    expect(fe.size).toBeGreaterThanOrEqual(20);
  });

  it('every FE call maps to a real backend handler', () => {
    expect([...fe].filter((r) => !be.has(r)).sort()).toEqual([]);
  });

  it('every backend handler is used by the FE except the scheduler-only drain', () => {
    expect([...be].filter((r) => !fe.has(r)).sort()).toEqual(['POST /sales-import/drain']);
  });
});

import { readFileSync, readdirSync, statSync } from 'fs';
import { builtinModules } from 'module';
import { join } from 'path';

/**
 * Two cheap guards for the Sales Import module:
 *  1. The FE contract mirror (platform/src/lib/sales-import/types.ts) stays IDENTICAL to the backend
 *     contract below its header comment, so the three lanes never drift apart.
 *  2. Every bare-package import under src/sales-import/** is a node builtin or a package.json
 *     `dependencies` entry (NOT a devDependency / unlisted). An unlisted runtime import builds green
 *     but crashes the prod image at boot (`npm ci --omit=dev`); see memory "delivery-status-reporting".
 */
const API_ROOT = join(__dirname, '..', '..');
const BE_CONTRACT = join(__dirname, 'sales-import.contract.ts');
const FE_CONTRACT = join(API_ROOT, '..', 'platform', 'src', 'lib', 'sales-import', 'types.ts');

const body = (src: string) => {
  const s = src.replace(/\r\n/g, '\n');
  const end = s.indexOf('*/');
  return s.slice(end + 2).trim();
};

describe('sales-import contract', () => {
  it('FE types.ts mirrors the backend contract exactly (below the header comment)', () => {
    expect(body(readFileSync(FE_CONTRACT, 'utf8'))).toBe(body(readFileSync(BE_CONTRACT, 'utf8')));
  });
});

describe('sales-import runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(join(API_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
  };
  const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) files.push(p);
    }
  };
  walk(__dirname);

  const pkgName = (spec: string) =>
    spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];

  it('imports only builtins and package.json `dependencies` (no devDependency, no unlisted package)', () => {
    const offenders: string[] = [];
    const re = /(?:^|\n)\s*import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(re)) {
        const spec = m[1] ?? m[2] ?? m[3];
        if (!spec || spec.startsWith('.')) continue;
        if (builtins.has(spec) || builtins.has(pkgName(spec))) continue;
        if (!pkg.dependencies[pkgName(spec)]) offenders.push(`${f.slice(API_ROOT.length + 1)} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exceljs is pinned to an exact version in `dependencies` (D-3)', () => {
    expect(pkg.dependencies.exceljs).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

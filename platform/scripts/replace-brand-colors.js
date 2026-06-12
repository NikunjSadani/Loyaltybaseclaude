const fs   = require('fs');
const path = require('path');

const EXCLUDE_PATHS = [
  path.join('src','lib','platform','client-config.ts'),
  path.join('src','lib','platform','client-registry.ts'),
  path.join('src','components','invoice','VisibilityInvoicePDF.ts'),
];

// Directories to skip entirely
const SKIP_DIRS = new Set(['__tests__', 'node_modules', '.next']);

function walk(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, results);
    } else if (entry.isFile() && /\.(tsx|ts)$/.test(entry.name)) {
      const rel = path.relative(process.cwd(), full);
      if (!EXCLUDE_PATHS.some(ex => rel === ex || rel.endsWith(ex))) {
        results.push(full);
      }
    }
  }
  return results;
}

const files = walk(path.join(process.cwd(), 'src'));
let updated = 0;

for (const file of files) {
  const orig = fs.readFileSync(file, 'utf8');
  const next = orig
    .replace(/#16a34a/g, 'var(--brand-primary)')
    .replace(/#15803d/g, 'var(--brand-primary-dark)')
    .replace(/#14532d/g, 'var(--brand-primary-dark)');
  if (next !== orig) {
    fs.writeFileSync(file, next, 'utf8');
    updated++;
  }
}

console.log(`Done. Updated ${updated} files.`);

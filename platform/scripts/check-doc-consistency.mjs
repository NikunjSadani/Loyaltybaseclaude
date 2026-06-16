#!/usr/bin/env node
/**
 * check-doc-consistency.mjs — doc-consistency staleness scan for Loyaltybase.
 *
 * WHAT IT DOES
 *   Recursively scans every `*.md` file under `docs/` (docs/spec/, docs/plans/,
 *   and all subdirs) for RETIRED concepts — names/phrases the owner-confirmed
 *   "real model" dropped during the de-scaffold. A retired term is a VIOLATION
 *   when it appears as if the concept were still live. It is OK when the line
 *   (or a nearby line, within ±NEIGHBOR_WINDOW) carries an annotation marker
 *   that flags it as historical (retire/legacy/deprecated/replace/stale/
 *   strikethrough/etc.), or when the whole file is allowlisted as legitimately
 *   discussing these terms.
 *
 *   This is the machine-enforced guard that stops stale docs from shipping. It
 *   is wired to a Stop hook and is a gate step — see docs/plans/DOC-MAINTENANCE.md.
 *
 * HOW TO RUN
 *   node scripts/check-doc-consistency.mjs
 *   Exit 0 = docs consistent. Exit 1 = at least one un-annotated stale reference.
 *   (Hooks / CI gate on the exit code.)
 *
 * HOW TO EXTEND (as the model evolves)
 *   - Retired a new concept? Add its name/phrase to RETIRED_TERMS below.
 *   - New way of marking text as historical? Add it to ANNOTATION_MARKERS.
 *   - A new doc legitimately discusses retired terms as its subject? Add its
 *     repo-relative path to ALLOWLIST.
 *   All three are plain arrays at the top of this file — edit and re-run.
 *
 * No npm deps: uses only node:fs / node:path. ESM (.mjs).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root = parent of this script's directory (scripts/..).
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');

// ── Retired concepts: must NOT appear in docs as if they're live. ───────────
// Identifier-ish terms (matched on word-ish boundaries) and free phrases.
const RETIRED_TERMS = [
  'PartnerClassConfig',
  'ChannelPartnerClass',
  'PartnerClassCode',
  'partnerClassId',
  'TierConfig',
  'PartnerTierHistory',
  'pointsMultiplier',
  'currentTierConfigId',
  'SkuCategoryMapping',
  'applicableClasses',
  'eligibleClasses',
  'partner class',
  'point tier',
  'loyalty tier',
  'SKU catalog',
  'invoice line item',
];

// ── Annotation markers: presence on the same/adjacent line => OK (historical).
const ANNOTATION_MARKERS = [
  'retire', // covers retire / retired / retiring / retires
  'legacy',
  'deprecated',
  'drop', // covers drop / dropped / dropping
  'decorative',
  'supersede', // covers supersede / superseded / supersedes
  'no longer',
  'do not use',
  'model-alignment',
  'de-scaffold',
  'p4.0',
  'stale', // scaffolding called out as stale
  'revert', // covers revert / reverted (catalog built-then-reverted)
  'yagni', // YAGNI / model-mismatch call-outs
  'empty table', // dormant retired schema "stays as harmless empty tables"
  '~~', // markdown strikethrough
  // Inline "this concept is gone / handled differently" phrasings the spec uses
  // when it names a retired term only to negate or replace it in the same breath:
  'replace', // covers replace / replaces / replaced / REPLACES
  'not partner class', // "(not partner class)" — explicit negation
];

// ── Allowlist: files where retired terms are legitimately the subject. ──────
// Repo-relative paths (POSIX-style); edit as new such docs appear.
const ALLOWLIST = [
  'docs/plans/MODEL-ALIGNMENT.md',
  'docs/spec/gap-register.md',
  'docs/plans/reconcile/P2-org-master-data.md',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Recursively collect absolute paths of all *.md files under a dir. */
function collectMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMarkdown(full));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative POSIX path for stable matching/printing. */
function relPosix(absPath) {
  return relative(REPO_ROOT, absPath).split(sep).join('/');
}

/**
 * Build a case-insensitive matcher for a retired term.
 * For identifier-ish terms (letters/digits only) we require word-ish
 * boundaries so we don't match inside a longer identifier. Phrases with
 * spaces match anywhere (boundary on the outer edges).
 */
function makeTermRegex(term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A "word-ish" boundary: not preceded/followed by a letter, digit or _.
  const left = '(?<![A-Za-z0-9_])';
  const right = '(?![A-Za-z0-9_])';
  return new RegExp(left + escaped + right, 'i');
}

const TERM_MATCHERS = RETIRED_TERMS.map((term) => ({ term, re: makeTermRegex(term) }));

const MARKER_RES = ANNOTATION_MARKERS.map(
  (m) => new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
);

function lineHasMarker(line) {
  return line !== undefined && MARKER_RES.some((re) => re.test(line));
}

// ── Scan ────────────────────────────────────────────────────────────────────

// How many lines on each side of a hit to scan for an annotation marker.
// ±2 covers markdown sentences that wrap across a couple of short lines.
const NEIGHBOR_WINDOW = 2;

const allowSet = new Set(ALLOWLIST);
const violations = []; // { path, lineNo, term, text }

// Resilience: if the docs dir isn't here (e.g. this is wired as a GLOBAL Stop
// hook and the current session is in some other project), no-op cleanly so the
// hook never errors. The scan only applies to this repo's docs/.
if (!existsSync(DOCS_DIR)) {
  if (!process.argv.includes('--hook')) console.log('✓ no docs/ here — nothing to scan');
  process.exit(0);
}

const mdFiles = collectMarkdown(DOCS_DIR);

for (const abs of mdFiles) {
  const rel = relPosix(abs);
  if (allowSet.has(rel)) continue;

  const lines = readFileSync(abs, 'utf8').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { term, re } of TERM_MATCHERS) {
      if (!re.test(line)) continue;
      // OK if this line or a nearby line (±NEIGHBOR_WINDOW) carries an
      // annotation marker. The window tolerates markdown prose/blockquotes
      // that wrap an annotated thought across a few short lines.
      let annotated = false;
      for (let j = i - NEIGHBOR_WINDOW; j <= i + NEIGHBOR_WINDOW; j++) {
        if (lineHasMarker(lines[j])) {
          annotated = true;
          break;
        }
      }
      if (annotated) continue;
      violations.push({ path: rel, lineNo: i + 1, term, text: line.trim() });
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────

const fileCount = new Set(violations.map((v) => v.path)).size;

// Stop-hook mode (`--hook`): surface a systemMessage ONLY on drift, and never
// block the turn (always exit 0). Used by the Stop hook in .claude/settings.json.
if (process.argv.includes('--hook')) {
  if (violations.length > 0) {
    const list = violations.map((v) => `${v.path}:${v.lineNo} (${v.term})`).join('; ');
    process.stdout.write(
      JSON.stringify({
        systemMessage:
          `⚠️ Doc drift: ${violations.length} stale reference(s) in ${fileCount} file(s) — ${list}. ` +
          `Fix the doc(s) or annotate (retired/DROPPED/~~…~~). See docs/plans/DOC-MAINTENANCE.md.`,
        suppressOutput: true,
      }),
    );
  }
  process.exit(0);
}

if (violations.length === 0) {
  console.log(`✓ docs consistent (${mdFiles.length} files scanned)`);
  process.exit(0);
}

for (const v of violations) {
  console.log(`${v.path}:${v.lineNo}: ${v.term} — ${v.text}`);
}

console.log('');
console.log(`✗ ${violations.length} stale reference(s) in ${fileCount} file(s)`);
process.exit(1);

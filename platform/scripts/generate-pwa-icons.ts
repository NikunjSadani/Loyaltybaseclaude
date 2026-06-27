/**
 * generate-pwa-icons.ts — per-tenant PWA icon pipeline.
 *
 * Generates the full installable PWA icon set for every registered tenant
 * (plus the `gifsy` operator console) from a source logo, falling back to a
 * branded MONOGRAM placeholder when no logo exists yet (the current state for
 * every tenant — owner supplies real art later).
 *
 * Output (per slug) — these EXACT paths are referenced by the manifest stream:
 *   public/icons/<slug>/icon-192.png             192x192  full-bleed   purpose "any"
 *   public/icons/<slug>/icon-512.png             512x512  full-bleed   purpose "any"
 *   public/icons/<slug>/icon-maskable-512.png    512x512  maskable     (glyph in inner 80% safe zone)
 *   public/icons/<slug>/apple-touch-icon-180.png 180x180  full-bleed   solid brand bg (no transparency)
 *
 * RUN (no build step needed — Node 22.6+/24 strips TS types natively):
 *   node platform/scripts/generate-pwa-icons.ts
 * (or, if you have tsx installed:  npx tsx platform/scripts/generate-pwa-icons.ts)
 *
 * Idempotent & offline: re-running overwrites the same files; no network access.
 *
 * DROP IN A REAL LOGO (later):
 *   Place the art at  platform/public/logos/<slug>.svg  (or .png) and re-run.
 *   The generator detects it and composites that logo onto the brand background
 *   instead of drawing the monogram. (`branding.logoUrl` pointing at a local
 *   /public path is also honored.)  See scripts/README-pwa-icons.md.
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

// ─────────────────────────────────────────────────────────────────────────────
// Tenant enumeration
//
// We deliberately re-declare the tenant branding here (slug/displayName/color/
// logoUrl) rather than import the TS registry, so this script stays a zero-config
// `node` runnable with no import-resolution / type-stripping edge cases. Keep in
// sync with platform/src/lib/platform/client-registry.ts — the source of truth.
// When onboarding wires this in (see README), pass the live ClientConfig instead.
// ─────────────────────────────────────────────────────────────────────────────

interface IconTenant {
  slug: string;
  displayName: string;
  primaryColor: string;       // 6-digit hex, e.g. "#16a34a"
  logoUrl?: string;           // optional local /public path to real art
}

const TENANTS: IconTenant[] = [
  // ── Registered tenants (mirror CLIENT_REGISTRY) ──
  { slug: 'deoleo',  displayName: 'Deoleo India',   primaryColor: '#16a34a', logoUrl: '/logos/deoleo.svg' },
  { slug: 'clientb', displayName: 'Client B Loyalty', primaryColor: '#2563eb', logoUrl: '/logos/clientb.svg' },
  // ── GIFSY platform-operator console (NOT in CLIENT_REGISTRY; no branding config) ──
  { slug: 'gifsy',   displayName: 'Gifsy',          primaryColor: '#111827' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLATFORM_ROOT = resolve(__dirname, '..');         // platform/
const PUBLIC_DIR = join(PLATFORM_ROOT, 'public');
const ICONS_ROOT = join(PUBLIC_DIR, 'icons');

// ─────────────────────────────────────────────────────────────────────────────
// Output spec — exact filenames/sizes (shared contract). Do not change.
// ─────────────────────────────────────────────────────────────────────────────

interface IconSpec {
  file: string;
  size: number;
  maskable: boolean;     // shrink glyph to inner 80% safe zone
  rounded: boolean;      // rounded-rect (PWA) vs full square (apple-touch)
}

const ICON_SPECS: IconSpec[] = [
  { file: 'icon-192.png',             size: 192, maskable: false, rounded: true  },
  { file: 'icon-512.png',             size: 512, maskable: false, rounded: true  },
  { file: 'icon-maskable-512.png',    size: 512, maskable: true,  rounded: false },
  { file: 'apple-touch-icon-180.png', size: 180, maskable: false, rounded: false },
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Initials: 1–2 uppercase letters derived from the display name. */
function initials(displayName: string): string {
  const words = displayName
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    const w = words[0];
    // Single word → first letter only (e.g. "Deoleo"→"D", "Gifsy"→"G").
    return w[0].toUpperCase();
  }
  // Multi-word → first letter of the first two significant words.
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Relative luminance (sRGB, WCAG) of a #rrggbb color, 0..1. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const h = m ? m[1] : '000000';
  const toLin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const r = toLin(parseInt(h.slice(0, 2), 16));
  const g = toLin(parseInt(h.slice(2, 4), 16));
  const b = toLin(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Pick a readable glyph color (black on light brand, white on dark brand). */
function contrastColor(brandHex: string): string {
  return luminance(brandHex) > 0.6 ? '#111111' : '#ffffff';
}

/** Build the monogram SVG string rendered at the target pixel size. */
function monogramSvg(opts: {
  size: number;
  brand: string;
  glyph: string;
  text: string;
  maskable: boolean;
  rounded: boolean;
}): string {
  const { size, brand, glyph, text, maskable, rounded } = opts;

  // Background: full square (apple-touch / maskable need opaque corners) or a
  // rounded-rect for the regular PWA icons.
  const radius = rounded ? Math.round(size * 0.18) : 0;
  const bg = rounded
    ? `<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${brand}"/>`
    : `<rect width="${size}" height="${size}" fill="${brand}"/>`;

  // Glyph box. For maskable, keep the glyph inside the inner 80% (Android masks
  // up to ~10% off each edge) → scale the font down so it never clips.
  const safeFactor = maskable ? 0.8 : 1;
  // Font size as a fraction of the icon; tighter for 2 letters than 1.
  const base = text.length >= 2 ? 0.46 : 0.6;
  const fontSize = Math.round(size * base * safeFactor);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    bg,
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" ` +
      `font-family="Arial, Helvetica, sans-serif" font-weight="700" ` +
      `font-size="${fontSize}" fill="${glyph}">${text}</text>`,
    `</svg>`,
  ].join('');
}

/**
 * Resolve a real source logo for the tenant, if one exists.
 * Checks public/logos/<slug>.(svg|png) and a local-path branding.logoUrl.
 * Returns an absolute file path or null (→ monogram fallback).
 */
function findSourceLogo(t: IconTenant): string | null {
  const candidates: string[] = [];
  for (const ext of ['svg', 'png']) {
    candidates.push(join(PUBLIC_DIR, 'logos', `${t.slug}.${ext}`));
  }
  if (t.logoUrl && t.logoUrl.startsWith('/')) {
    candidates.push(join(PUBLIC_DIR, t.logoUrl.replace(/^\//, '')));
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Compose one icon file from a real source logo over the brand background. */
async function renderFromLogo(
  logoPath: string,
  brand: string,
  spec: IconSpec,
  outPath: string,
): Promise<void> {
  const { size, maskable, rounded } = spec;
  // Logo occupies the safe area: 80% for maskable, ~88% otherwise (a little
  // breathing room so the art doesn't touch the rounded corners).
  const inner = Math.round(size * (maskable ? 0.7 : 0.84));

  const isSvg = logoPath.toLowerCase().endsWith('.svg');
  const logoBuf = isSvg
    ? await sharp(readFileSync(logoPath), { density: 384 }).resize(inner, inner, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      }).png().toBuffer()
    : await sharp(readFileSync(logoPath)).resize(inner, inner, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      }).png().toBuffer();

  const radius = rounded ? Math.round(size * 0.18) : 0;
  const bgSvg = rounded
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${brand}"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="${brand}"/></svg>`;

  await sharp(Buffer.from(bgSvg))
    .composite([{ input: logoBuf, gravity: 'center' }])
    .png()
    .toFile(outPath);
}

/** Render one icon file from the monogram placeholder. */
async function renderFromMonogram(
  t: IconTenant,
  glyphColor: string,
  text: string,
  spec: IconSpec,
  outPath: string,
): Promise<void> {
  const svg = monogramSvg({
    size: spec.size,
    brand: t.primaryColor,
    glyph: glyphColor,
    text,
    maskable: spec.maskable,
    rounded: spec.rounded,
  });
  // Rasterize the SVG AT the target size for crispness (no upscaling).
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function generateForTenant(t: IconTenant): Promise<void> {
  const outDir = join(ICONS_ROOT, t.slug);
  mkdirSync(outDir, { recursive: true });

  const source = findSourceLogo(t);
  const text = initials(t.displayName);
  const glyph = contrastColor(t.primaryColor);
  const mode = source ? `logo (${source})` : `monogram "${text}"`;

  console.log(`\n[${t.slug}] ${t.displayName} — ${t.primaryColor} — ${mode}`);

  for (const spec of ICON_SPECS) {
    const outPath = join(outDir, spec.file);
    if (source) {
      await renderFromLogo(source, t.primaryColor, spec, outPath);
    } else {
      await renderFromMonogram(t, glyph, text, spec, outPath);
    }
    console.log(`   ✓ ${join('public', 'icons', t.slug, spec.file)}  (${spec.size}x${spec.size}${spec.maskable ? ', maskable' : ''})`);
  }
}

async function main(): Promise<void> {
  console.log(`Generating PWA icons for ${TENANTS.length} slug(s) → ${ICONS_ROOT}`);
  for (const t of TENANTS) {
    await generateForTenant(t);
  }
  console.log(`\nDone. ${TENANTS.length} icon set(s) written.`);
}

main().catch((err) => {
  console.error('PWA icon generation failed:', err);
  process.exit(1);
});

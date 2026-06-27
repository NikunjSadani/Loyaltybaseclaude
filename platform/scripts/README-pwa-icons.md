# PWA icon pipeline

Generates the per-tenant PWA icon set (placeholder monograms today, real logos
later) for every registered tenant plus the `gifsy` operator console.

## Run

From the repo root (or anywhere — paths are resolved relative to the script):

```bash
node platform/scripts/generate-pwa-icons.ts
```

> Node 22.6+/24 strips TypeScript types natively, so no build step or `tsx` is
> required. If you happen to have `tsx` installed you can also run
> `npx tsx platform/scripts/generate-pwa-icons.ts` — same result.

The script is **idempotent** (re-running overwrites the same files) and needs
**no network access**.

## Output (shared contract — do not rename)

For each `<slug>` it writes, under `platform/public/icons/<slug>/`:

| File                          | Size      | Purpose                                                        |
| ----------------------------- | --------- | ------------------------------------------------------------- |
| `icon-192.png`                | 192×192   | full-bleed, manifest `purpose: "any"`                         |
| `icon-512.png`                | 512×512   | full-bleed, manifest `purpose: "any"`                         |
| `icon-maskable-512.png`       | 512×512   | maskable — glyph kept inside the inner 80% safe zone          |
| `apple-touch-icon-180.png`    | 180×180   | iOS home-screen; opaque brand bg (no transparency)            |

Slugs generated: every tenant in `CLIENT_REGISTRY` (currently `deoleo`,
`clientb`) **plus** `gifsy` (the platform-operator console — it is *not* a
registry tenant and has no branding config, so it uses displayName "Gifsy" and
brand color `#111827`).

## Placeholder monograms (current state)

No tenant has real art yet, so every icon is a **monogram placeholder**: a
brand-colored rounded square (full square for the maskable + apple-touch
variants) with the tenant's initials in a contrasting color. The glyph color is
chosen automatically by luminance (white on dark brands, near-black on light
brands). Initials are derived from the display name (e.g. `Deoleo India` → `DI`,
`Gifsy` → `G`).

## Drop in a real logo (later)

When the owner supplies real art for a tenant:

1. Save it at **`platform/public/logos/<slug>.svg`** (preferred — vector scales
   crisply) or **`platform/public/logos/<slug>.png`** (use a large square
   source, ≥512px). A local `branding.logoUrl` (a `/…` path under `public/`) is
   also honored.
2. Re-run `node platform/scripts/generate-pwa-icons.ts`.

The generator detects the logo and composites it (centered, within the safe
area) onto the brand-color background instead of drawing the monogram. No code
change needed.

## Wiring into tenant onboarding (note for the orchestrator/owner)

The tenant-creation chokepoint is **`api/src/gifsy/gifsy.service.ts` →
`createClient(user, dto)`** (the GIFSY operator console's "new client" flow;
controller `api/src/gifsy/gifsy.controller.ts`, registry seed
`platform/src/lib/platform/client-registry.ts`).

To auto-provision icons on onboarding, invoke this generator for the new slug
right after the client record is persisted in `createClient` — either by
shelling out to the script for that single slug, or by extracting
`generateForTenant` into a small library function and calling it with the live
`ClientConfig` (slug / displayName / primaryColor / logoUrl). This script is not
wired in yet — it is run manually per the command above.

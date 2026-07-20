-- ✅ RAN ON PROD + STAGING 2026-07-19 (idempotent — re-running is a no-op). Do NOT re-run casually.
-- §A-DOMAIN P5 prerequisite — BRANDING BACKFILL (fill-gaps, idempotent, additive).
-- Copies each tenant's FULL branding from the in-code CLIENT_REGISTRY into clients.branding,
-- WITHOUT overwriting any value the operator already set: each field =
-- COALESCE(existing-non-empty, registry-value). Running twice is a no-op.
-- After this, branding serves fully from the DB → CLIENT_REGISTRY can be retired (P5).
-- Owner-gated prod/staging write: take a fresh backup first; run via the in-VPC guarded job.
-- Read-back to verify: SELECT id, branding FROM clients WHERE id IN ('deoleo','clientb');
--
-- HARDENING (post independent audit, GO-WITH-FIXES):
--   * The whole thing is ONE atomic DO block so the current_database() guard runs in the
--     SAME transaction as the UPDATE — it genuinely aborts before any write even under an
--     autocommit runner (the separate-statement version did NOT protect the UPDATE).
--   * `AND jsonb_typeof(c.branding)='object'` guards the `||` merge — a JSON-scalar `null`
--     or array branding value would otherwise corrupt the column into an array instead of
--     merging. Not reachable for the known deoleo row, defensive only.
--   * ROW_COUNT assertion (== 1) fails loud on a mistyped/absent id (as written the UPDATE
--     would silently touch 0 rows).

-- ─────────────────────────────────────────────────────────────────────────────
-- PROD  (guard: gifsy_prod). Live tenant = deoleo. (`demo` is not a registry tenant → skipped.)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  n int;
BEGIN
  IF current_database() <> 'gifsy_prod' THEN
    RAISE EXCEPTION 'ABORT: not gifsy_prod (current=%)', current_database();
  END IF;

  UPDATE clients c
  SET branding = c.branding || jsonb_build_object(
    'displayName',      COALESCE(NULLIF(c.branding->>'displayName',''),      'Deoleo India'),
    'primaryColor',     COALESCE(NULLIF(c.branding->>'primaryColor',''),     '#16a34a'),
    'logoUrl',          COALESCE(NULLIF(c.branding->>'logoUrl',''),          '/logos/deoleo.svg'),
    'wordmarkWhiteUrl', COALESCE(NULLIF(c.branding->>'wordmarkWhiteUrl',''), '/brand/deoleo-wordmark-white.png'),
    'wordmarkColorUrl', COALESCE(NULLIF(c.branding->>'wordmarkColorUrl',''), '/brand/deoleo-wordmark-color.png'),
    'faviconUrl',       COALESCE(NULLIF(c.branding->>'faviconUrl',''),       '/favicons/deoleo.ico'),
    'supportEmail',     COALESCE(NULLIF(c.branding->>'supportEmail',''),     'support@deoleo.gifsy.in'),
    'supportPhone',     COALESCE(NULLIF(c.branding->>'supportPhone',''),     '+91-1800-000-0001'),
    'productBrands',    CASE WHEN COALESCE(jsonb_typeof(c.branding->'productBrands'),'null') <> 'array'
                               OR c.branding->'productBrands' = '[]'::jsonb
                             THEN '["Bertolli","Figaro"]'::jsonb
                             ELSE c.branding->'productBrands' END
  )
  WHERE c.id = 'deoleo'
    AND jsonb_typeof(c.branding) = 'object';

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ABORT: expected exactly 1 deoleo row updated, got % (rolled back)', n;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- STAGING variant (run separately with guard gifsy_staging) — deoleo (same fill as above)
-- PLUS clientb from CLIENT_B_CONFIG (staging-only demo tenant; no wordmark URLs in the registry).
-- Uncomment to run against staging. Asserts BOTH rows updated (deoleo + clientb).
-- ─────────────────────────────────────────────────────────────────────────────
-- DO $$
-- DECLARE
--   n int;
-- BEGIN
--   IF current_database() <> 'gifsy_staging' THEN
--     RAISE EXCEPTION 'ABORT: not gifsy_staging (current=%)', current_database();
--   END IF;
--
--   UPDATE clients c
--   SET branding = c.branding || jsonb_build_object(
--     'displayName',      COALESCE(NULLIF(c.branding->>'displayName',''),      'Deoleo India'),
--     'primaryColor',     COALESCE(NULLIF(c.branding->>'primaryColor',''),     '#16a34a'),
--     'logoUrl',          COALESCE(NULLIF(c.branding->>'logoUrl',''),          '/logos/deoleo.svg'),
--     'wordmarkWhiteUrl', COALESCE(NULLIF(c.branding->>'wordmarkWhiteUrl',''), '/brand/deoleo-wordmark-white.png'),
--     'wordmarkColorUrl', COALESCE(NULLIF(c.branding->>'wordmarkColorUrl',''), '/brand/deoleo-wordmark-color.png'),
--     'faviconUrl',       COALESCE(NULLIF(c.branding->>'faviconUrl',''),       '/favicons/deoleo.ico'),
--     'supportEmail',     COALESCE(NULLIF(c.branding->>'supportEmail',''),     'support@deoleo.gifsy.in'),
--     'supportPhone',     COALESCE(NULLIF(c.branding->>'supportPhone',''),     '+91-1800-000-0001'),
--     'productBrands',    CASE WHEN COALESCE(jsonb_typeof(c.branding->'productBrands'),'null') <> 'array'
--                                OR c.branding->'productBrands' = '[]'::jsonb
--                              THEN '["Bertolli","Figaro"]'::jsonb
--                              ELSE c.branding->'productBrands' END
--   )
--   WHERE c.id = 'deoleo' AND jsonb_typeof(c.branding) = 'object';
--   GET DIAGNOSTICS n = ROW_COUNT;
--   IF n <> 1 THEN RAISE EXCEPTION 'ABORT: expected 1 deoleo row, got % (rolled back)', n; END IF;
--
--   UPDATE clients c
--   SET branding = c.branding || jsonb_build_object(
--     'displayName',  COALESCE(NULLIF(c.branding->>'displayName',''),  'Client B Loyalty'),
--     'primaryColor', COALESCE(NULLIF(c.branding->>'primaryColor',''), '#2563eb'),
--     'logoUrl',      COALESCE(NULLIF(c.branding->>'logoUrl',''),      '/logos/clientb.svg'),
--     'faviconUrl',   COALESCE(NULLIF(c.branding->>'faviconUrl',''),   '/favicons/clientb.ico'),
--     'supportEmail', COALESCE(NULLIF(c.branding->>'supportEmail',''), 'support@clientb.gifsy.in'),
--     'supportPhone', COALESCE(NULLIF(c.branding->>'supportPhone',''), '+91-1800-000-0002')
--   )
--   WHERE c.id = 'clientb' AND jsonb_typeof(c.branding) = 'object';
--   GET DIAGNOSTICS n = ROW_COUNT;
--   IF n <> 1 THEN RAISE EXCEPTION 'ABORT: expected 1 clientb row, got % (rolled back)', n; END IF;
-- END $$;

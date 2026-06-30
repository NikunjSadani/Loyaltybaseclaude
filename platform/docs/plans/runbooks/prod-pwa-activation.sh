#!/usr/bin/env bash
#
# Prod PWA activation — the exact commands for CUTOVER-RUNBOOK.md Step 1 (secrets)
# and Step 7 (scheduler). This is a REFERENCE script: run the blocks deliberately at
# cutover, on the owner's explicit go — it is NOT auto-run and NOT wired into CI.
#
# Mirrors the staging wiring (push-drain-staging + VAPID/PUSH_DRAIN secrets) onto prod.
# Prod secret NAMES match .github/workflows/deploy.yml exactly:
#   VAPID_PUBLIC_KEY · VAPID_PRIVATE_KEY · PUSH_DRAIN_SECRET   (no *_STAGING suffix)
#
# Prereq: gcloud authed to project gifsy-platform; the prod secrets must EXIST before
# the deploy.yml PWA refs reach main (i.e. run STEP 1 before merging the prep branch).
set -euo pipefail

PROJECT=gifsy-platform
REGION=asia-south1
SA=gifsy-api-sa@${PROJECT}.iam.gserviceaccount.com

# ─── STEP 1 — create the three prod secrets ───────────────────────────────────────
# 1a. Generate a fresh VAPID keypair (single platform-wide pair, same as staging).
#     Requires web-push; run from api/ where it's a dependency, or `npx web-push`.
#     It prints "Public Key:" and "Private Key:" — capture both.
#       cd api && npx web-push generate-vapid-keys
VAPID_PUBLIC="<paste the generated Public Key>"
VAPID_PRIVATE="<paste the generated Private Key>"

# 1b. Generate a fresh push-drain shared secret (any high-entropy hex; NOT the staging one).
#       openssl rand -hex 32
DRAIN_SECRET="<paste a fresh 64-char hex>"

# 1c. Create the secrets (add a version holding the value) + grant the api SA read access.
for pair in \
  "VAPID_PUBLIC_KEY:${VAPID_PUBLIC}" \
  "VAPID_PRIVATE_KEY:${VAPID_PRIVATE}" \
  "PUSH_DRAIN_SECRET:${DRAIN_SECRET}"; do
  NAME="${pair%%:*}"; VALUE="${pair#*:}"
  gcloud secrets create "$NAME" --project "$PROJECT" --replication-policy=automatic 2>/dev/null || true
  printf '%s' "$VALUE" | gcloud secrets versions add "$NAME" --project "$PROJECT" --data-file=-
  gcloud secrets add-iam-policy-binding "$NAME" --project "$PROJECT" \
    --member="serviceAccount:${SA}" --role=roles/secretmanager.secretAccessor
done
echo "✓ Prod PWA secrets created. NOW merge prep/prod-pwa-activation → develop, then cut over."

# ─── STEP 7 — create the push-drain-prod scheduler (after prod is deployed) ─────────
# Mirrors push-drain-staging: POST the internal drain endpoint every minute; the request
# un-throttles Cloud Run CPU so the @Interval delivery worker ticks (TRAP #5). The drain
# endpoint is fail-closed on the x-drain-secret header.
PROD_API_URL="$(gcloud run services describe gifsy-api --project "$PROJECT" --region "$REGION" \
  --format='value(status.url)')"

gcloud scheduler jobs create http push-drain-prod \
  --project "$PROJECT" --location "$REGION" \
  --schedule="* * * * *" \
  --uri="${PROD_API_URL}/v1/push/drain" \
  --http-method=POST \
  --headers="Content-Type=application/octet-stream,x-drain-secret=${DRAIN_SECRET}" \
  --message-body=" "
echo "✓ push-drain-prod scheduler created against ${PROD_API_URL}/v1/push/drain"

# Smoke: no-secret → 403, with-secret → 201, then confirm one real device push.
#   curl -s -o /dev/null -w '%{http_code}\n' -X POST "${PROD_API_URL}/v1/push/drain" -H 'Content-Length: 0'
#   curl -s -o /dev/null -w '%{http_code}\n' -X POST "${PROD_API_URL}/v1/push/drain" -H "x-drain-secret: ${DRAIN_SECRET}" -H 'Content-Length: 0'

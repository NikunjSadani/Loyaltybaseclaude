# Loyaltybase — working agreements (Claude)

Multi-tenant FMCG trade-loyalty platform (operator **Gifsy**, launching client **Deoleo**). Backend `api/`
(NestJS + Prisma — owns the DB + ALL business logic) · thin frontend `platform/` (Next.js, proxies `/api/*` →
backend `/v1/*`). Work on branch **`develop`** (auto-deploys to staging).

**Full project state, the THINGS-TO-BE-DONE list, open items, and the traps live in
`platform/docs/plans/RESUME.md`** (the post-compact restart prompt) and `platform/docs/plans/GO-LIVE-ISSUE-LIST.md`
(the master tracker). **Read RESUME.md first** — this file is only the always-on working agreements.

## Standing working agreements (always apply — reinforced by the owner; do not need re-reminding)

1. **Clarify before an imperfect build.** If I recognize an approach is NOT the ideal / complete solution, ASK &
   clarify with the owner BEFORE building — do NOT ship a caveated partial and iterate. The tell is writing "one
   honest caveat remains…" / "rare edge…" / "good enough for the common case" about a gap I already understand →
   STOP, present the ideal vs the shortcut, and let the owner choose. Caveats are only for truly rare/unknowable
   edges (and even then, say why closing them isn't worth it). *(The sales KYC page took 3 turns because I shipped
   known-partial fixes behind caveats.)*
2. **A fix is DONE only when EVERY consumer + alternate data path + scale case is traced** — not just the visible
   one (grep all consumers; check the 10-row vs 2,261-row scale case; check the alternate entry path).
3. **Orchestrate by default.** Decompose substantial work into PARALLEL sub-agents (they write code, I run the
   gates); I personally do the INDEPENDENT adversarial audit + FULL gate + runtime-verify. Genuinely reconsider
   when the owner challenges a recommendation.
4. **Verify at runtime.** A flow is done only when exercised end-to-end (real login per role) — never on the
   strength of `tsc`/tests alone. The owner completes OTP logins / real-user UAT.
5. **Own doc + memory consistency.** When a fact changes, sweep EVERY doc + memory in the SAME pass — never leave a
   stale caveat, HEAD, gate number, or model note behind.

## Gates — run the FULL suites before EVERY push (a red suite silently skips the staging deploy via `needs: test`)

`cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run` ·
`cd platform && npx tsc --noEmit`

## Guardrails

- Never merge to `main`, trigger a prod cutover, or run a prod/staging DB op without the owner (staging+prod share
  a private-IP DB — reads need a `current_database()` guard; writes need backup + shown SQL + wait).
- Never expose secrets. Commit footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

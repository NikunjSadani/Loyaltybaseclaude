# Loyaltybase — working agreements (Claude)

Multi-tenant FMCG trade-loyalty platform (operator **Gifsy**, launching client **Deoleo**). Backend `api/`
(NestJS + Prisma — owns the DB + ALL business logic) · thin frontend `platform/` (Next.js, proxies `/api/*` →
backend `/v1/*`). Work on branch **`develop`** (auto-deploys to staging).

**Full project state, the THINGS-TO-BE-DONE list, open items, and the traps live in
`platform/docs/plans/RESUME.md`** (the post-compact restart prompt) and `platform/docs/plans/GO-LIVE-ISSUE-LIST.md`
(the master tracker). **Read RESUME.md first** — this file is only the always-on working agreements. Every doc is listed
in `platform/docs/DOCS-INDEX.md` (with the release log); update docs in the same PR as the code and RESUME.md at every release.

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

**Run `bash scripts/gates.sh`** (the canonical runner) — it runs all four suites and exits NON-ZERO on any
failure using each command's REAL exit code. Read ITS exit code / `GATES: ✅/❌` line. The four gates it wraps:
`cd api && npx jest --no-coverage` · `cd api && npx nest build` · `cd platform && npx vitest run` ·
`cd platform && npx tsc --noEmit`. `bash scripts/gates.sh --fast` runs just the compile gates (build + tsc).

⚠️ **NEVER trust a piped exit code** (gate #6): `npx nest build | tail` reports *tail's* exit (always 0), so a
RED build looks green — this masked a real `nest build` failure on 2026-11-03. Always run gates via the script,
or capture `$?` of the bare command. A committed **pre-push hook** (`.githooks/pre-push`, activate once with
`bash scripts/setup-hooks.sh`) runs the FULL `scripts/gates.sh` on any code push and BLOCKS a red push
(`GATES_SKIP=1 git push` bypasses in an emergency; docs-only pushes skip it).

## 🚦 PLATFORM-WIDE CHANGE GATE — the owner's hardest rule (never let this lapse)

A **PLATFORM-WIDE** change (shared code / schema / default behaviour — anything reaching other tenants, incl. the
**LIVE Deoleo** program) ships **ONLY after the owner's EXPLICIT, in-session approval**, and I must flag it to them
as platform-wide **BEFORE I build it** — flagging is not approval, and "I'll build it then ask" is a violation.
A **TENANT-SCOPED** change (one tenant only — per-tenant config / branding / flag) does not need this; prefer the
tenant-scoped path whenever one exists. *(This rule was broken once by shipping flagged-but-unapproved shared changes
across compactions — hence the enforcement below.)*

**Every change, do this — don't skip because it "looks small":**
1. **Classify** TENANT-SCOPED vs PLATFORM-WIDE and state it in the plan.
2. **Before building** anything platform-wide → request approval with a prominent **⚠️ PLATFORM-WIDE** callout
   (what it touches, which tenants incl. Deoleo, why it can't be tenant-scoped). Wait for an explicit YES.
3. **Before pushing** → re-confirm the push contains only tenant-scoped work OR work the owner explicitly approved
   as platform-wide **in this session**. If not → do not push.

**Enforcement (survives compaction — do not remove without the owner):**
- `.claude/hooks/platform-wide-gate.js` + `.claude/settings.json` — a `PreToolUse` hook that forces a platform-wide
  checklist prompt on every `git push` (→ shared staging) and every prod-deploy dispatch (→ live Deoleo). The harness
  runs it independent of my context, so it cannot be lost to compaction. This note + memory `[[platform-wide-change-approval]]`
  are the passive layer; the hook is the active one.

## Guardrails

- Never merge to `main`, trigger a prod cutover, or run a prod/staging DB op without the owner (staging+prod share
  a private-IP DB — reads need a `current_database()` guard; writes need backup + shown SQL + wait).
- Never expose secrets. Commit footer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

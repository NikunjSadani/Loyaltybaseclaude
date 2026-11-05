#!/usr/bin/env node
/*
 * platform-wide-gate.js — PreToolUse(Bash) ENFORCEMENT for the owner's hard rule:
 *   a PLATFORM-WIDE change (shared code / all tenants, incl. LIVE Deoleo) ships ONLY
 *   after the owner's EXPLICIT approval, flagged as platform-wide BEFORE building/pushing.
 *
 * Why a hook (not just a memory/CLAUDE.md note): memories and notes are PASSIVE — they
 * only work if the model reads and obeys them, and after several context compactions that
 * is exactly what failed. The harness runs this hook on EVERY Bash call regardless of
 * conversation context, so it CANNOT be lost to compaction. It intercepts the two
 * irreversible shared-impact chokepoints and forces an explicit platform-wide checkpoint:
 *   • `git push`  → develop auto-deploys to shared STAGING; that code later reaches prod/Deoleo.
 *   • prod deploy dispatch (`gh workflow run … deploy`, workflow_dispatch, deploy.yml) → LIVE Deoleo.
 *
 * It returns permissionDecision:"ask" with a checklist as the reason, so the owner (and the
 * model) see the gate at the moment of action. Node is used (not bash/jq) for Windows safety.
 * Pure read of stdin; never mutates anything. Non-push/deploy commands pass through untouched.
 */
let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  let cmd = '';
  try {
    cmd = ((JSON.parse(data || '{}').tool_input) || {}).command || '';
  } catch {
    process.exit(0); // unparseable → don't interfere
  }

  const noisy = /--dry-run|--help|(^|\s)-h(\s|$)/.test(cmd);
  const isPush = /\bgit\b[\s\S]*\bpush\b/.test(cmd) && !noisy;
  const isProdDeploy =
    /\bgh\s+workflow\s+run\b/.test(cmd) ||
    /workflow_dispatch/.test(cmd) ||
    /\bdeploy\.ya?ml\b/.test(cmd);

  if (!isPush && !isProdDeploy) process.exit(0); // not a gated action → default allow

  const scope = isProdDeploy
    ? '🔴 PROD DEPLOY → LIVE Deoleo and every tenant. This is the highest-stakes action in the repo.'
    : '🚦 PUSH → develop auto-deploys to shared STAGING; this same code is what later reaches prod/Deoleo.';

  const reason = [
    scope,
    '',
    'STOP and verify before confirming:',
    '  1. Is EVERY change here tenant-scoped, or is any part PLATFORM-WIDE',
    '     (shared code / schema / default behaviour, reaching other tenants incl. live Deoleo)?',
    '  2. If ANY part is platform-wide: did the owner give EXPLICIT approval IN THIS SESSION,',
    '     AFTER I flagged it to them as platform-wide (with the ⚠️ callout)?',
    '  3. No explicit approval → DENY this and go get it first. Prefer a tenant-scoped path when one exists.',
    '',
    'Approve ONLY if (1) is all tenant-scoped, or (2) is a clear, in-session yes.',
  ].join('\n');

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
});

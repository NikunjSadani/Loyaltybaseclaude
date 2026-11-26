'use client';

/**
 * New-rule route — the builder in create mode. `?from=<rule row id>` = "Duplicate rule": the builder opens as a NEW
 * rule (new ruleId on save, draft) pre-filled from that rule; the original is untouched and nothing is saved until
 * the author clicks Save draft.
 */

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { RuleBuilder } from '../_components/RuleBuilder';

function NewRuleInner() {
  const params = useSearchParams();
  const from = params.get('from')?.trim() || undefined;
  return <RuleBuilder ruleId="new" duplicateFromId={from} />;
}

export default function NewRulePage() {
  return (
    <Suspense fallback={null}>
      <NewRuleInner />
    </Suspense>
  );
}

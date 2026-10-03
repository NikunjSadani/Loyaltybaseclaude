'use client';

/**
 * Rule builder route — edit a draft, or view a published/archived version read-only.
 * `id === 'new'` is handled by the sibling `new/page.tsx`; here `id` is always a stored rule id.
 */

import { useParams } from 'next/navigation';
import { RuleBuilder } from '../_components/RuleBuilder';

export default function RuleBuilderPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  return <RuleBuilder ruleId={id} />;
}

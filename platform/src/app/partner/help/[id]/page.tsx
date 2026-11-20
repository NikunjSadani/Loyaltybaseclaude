'use client';

import { use } from 'react';
import { HelpTopicDetail } from '@/components/help/help-topics';

/** Partner app — one Help & videos guide (video + numbered steps). */
export default function PartnerHelpTopicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <HelpTopicDetail apiBase="/api/partner/help-topics" id={id} listHref="/partner/help" />;
}

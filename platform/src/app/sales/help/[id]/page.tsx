'use client';

import { use } from 'react';
import { HelpTopicDetail } from '@/components/help/help-topics';

/** Sales app — one Help & videos guide (video + numbered steps). */
export default function SalesHelpTopicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <HelpTopicDetail apiBase="/api/sales/help-topics" id={id} listHref="/sales/help" />;
}

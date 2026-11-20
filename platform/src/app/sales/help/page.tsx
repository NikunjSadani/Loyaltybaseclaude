'use client';

import { HelpTopicList } from '@/components/help/help-topics';

/** Sales app — Help & videos list (tenant flag helpVideos; entry point on Profile). */
export default function SalesHelpPage() {
  return <HelpTopicList apiBase="/api/sales/help-topics" hrefBase="/sales/help" backHref="/sales/profile" />;
}

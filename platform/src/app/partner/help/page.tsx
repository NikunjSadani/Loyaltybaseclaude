'use client';

import { HelpTopicList } from '@/components/help/help-topics';

/** Partner app — Help & videos list (tenant flag helpVideos; entry point on Profile). */
export default function PartnerHelpPage() {
  return <HelpTopicList apiBase="/api/partner/help-topics" hrefBase="/partner/help" backHref="/partner/profile" />;
}

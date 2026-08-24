'use client';

/** /vendor — no landing of its own; send the vendor straight to their catalogue. */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function VendorIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/vendor/catalogue');
  }, [router]);
  return (
    <div className="px-4 py-16 text-center text-gray-400 text-sm">
      <Loader2 className="w-4 h-4 animate-spin inline mr-2" aria-label="Loading" />
      Opening your catalogue…
    </div>
  );
}

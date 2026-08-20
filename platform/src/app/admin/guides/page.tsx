'use client';

import Link from 'next/link';
import { BookOpen, ChevronRight } from 'lucide-react';
import { GUIDES } from '@/content/guides';

/**
 * Help & Guides index — the list of internal operating guides for the Gifsy ops team.
 * Gated to GIFSY_ADMIN + GIFSY_STAFF via admin/guides/layout.tsx.
 */
export default function GuidesIndexPage() {
  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-[var(--brand-primary)]" />
          Help &amp; Guides
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Step-by-step operating guides for the Gifsy team. Open a guide to read it, or use the
          Print button inside to save a copy.
        </p>
      </div>

      <div className="space-y-3">
        {GUIDES.map((g) => (
          <Link
            key={g.slug}
            href={`/admin/guides/${g.slug}`}
            className="group block rounded-xl border border-gray-200 bg-white p-4 hover:border-[var(--brand-primary)] hover:shadow-sm transition-all"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900 group-hover:text-[var(--brand-primary)]">
                  {g.title}
                </h2>
                <p className="text-sm text-gray-500 mt-1">{g.summary}</p>
                <p className="text-xs text-gray-400 mt-2">Last reviewed {g.updated}</p>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-300 group-hover:text-[var(--brand-primary)] shrink-0 mt-1" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

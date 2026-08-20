'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getGuide } from '@/content/guides';

/**
 * Guide viewer — renders a guide's markdown (GFM) with a Print button (Save-as-PDF works from the
 * browser print dialog; the admin chrome is `print:hidden` so the printout is just the guide).
 * Screenshots come from /guides/<slug>/*.png (public static). Gated to Gifsy operators via layout.
 */
export default function GuideViewerPage() {
  const params = useParams();
  const slug = Array.isArray(params.slug) ? params.slug[0] : params.slug;
  const guide = slug ? getGuide(slug) : undefined;

  if (!guide) {
    return (
      <div className="max-w-2xl">
        <p className="text-sm text-gray-600">That guide doesn&apos;t exist.</p>
        <Link href="/admin/guides" className="text-sm text-[var(--brand-primary)] underline mt-2 inline-block">
          ← Back to Help &amp; Guides
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-3xl">
      {/* Toolbar — hidden when printing */}
      <div className="flex items-center justify-between mb-5 print:hidden">
        <Link
          href="/admin/guides"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4" />
          Help &amp; Guides
        </Link>
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <Printer className="w-4 h-4" />
          Print / Save PDF
        </button>
      </div>

      <article className="rounded-xl border border-gray-200 bg-white px-6 py-6 sm:px-8 print:border-0 print:px-0">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => <h1 className="text-2xl font-bold text-gray-900 mb-3">{children}</h1>,
            h2: ({ children }) => (
              <h2 className="text-lg font-bold text-gray-900 mt-8 mb-2 border-t border-gray-100 pt-6">{children}</h2>
            ),
            h3: ({ children }) => <h3 className="text-base font-semibold text-gray-900 mt-5 mb-2">{children}</h3>,
            h4: ({ children }) => <h4 className="text-sm font-semibold text-gray-900 mt-4 mb-1">{children}</h4>,
            p: ({ children }) => <p className="text-sm text-gray-700 leading-relaxed my-3">{children}</p>,
            pre: ({ children }) => (
              <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 my-3 overflow-x-auto text-xs">{children}</pre>
            ),
            ul: ({ children }) => <ul className="list-disc pl-6 my-3 space-y-1 text-sm text-gray-700">{children}</ul>,
            ol: ({ children }) => <ol className="list-decimal pl-6 my-3 space-y-2 text-sm text-gray-700">{children}</ol>,
            li: ({ children }) => <li className="leading-relaxed">{children}</li>,
            strong: ({ children }) => <strong className="font-semibold text-gray-900">{children}</strong>,
            em: ({ children }) => <em className="italic">{children}</em>,
            a: ({ href, children }) => (
              <a href={href} className="text-[var(--brand-primary)] underline">{children}</a>
            ),
            blockquote: ({ children }) => (
              <blockquote className="border-l-4 border-amber-300 bg-amber-50 px-4 py-2 my-4 text-sm text-gray-700 rounded-r">
                {children}
              </blockquote>
            ),
            hr: () => <hr className="my-6 border-gray-200" />,
            code: ({ children }) => (
              <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs font-mono">{children}</code>
            ),
            table: ({ children }) => (
              <div className="overflow-x-auto my-4">
                <table className="w-full text-sm border-collapse">{children}</table>
              </div>
            ),
            th: ({ children }) => (
              <th className="text-left font-semibold bg-gray-50 border border-gray-200 px-3 py-2">{children}</th>
            ),
            td: ({ children }) => (
              <td className="border border-gray-200 px-3 py-2 align-top text-gray-700">{children}</td>
            ),
            img: ({ src, alt }) => (
              <figure className="my-4">
                {/* Screenshots are public static under /guides/<slug>/; plain img is intentional. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={typeof src === 'string' ? src : ''}
                  alt={alt ?? ''}
                  className="rounded-lg border border-gray-200 shadow-sm max-w-full"
                />
                {alt ? <figcaption className="text-xs text-gray-400 mt-1.5">{alt}</figcaption> : null}
              </figure>
            ),
          }}
        >
          {guide.markdown}
        </ReactMarkdown>

        <p className="text-xs text-gray-400 mt-8 border-t border-gray-100 pt-4">
          Last reviewed {guide.updated}.
        </p>
      </article>
    </div>
  );
}

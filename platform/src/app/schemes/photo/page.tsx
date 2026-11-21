'use client';

/**
 * Scheme media viewer — the target of the scheme enrollment Excel export's "Open photo" / "Open file" links
 * (`https://<tenant host>/schemes/photo?key=<scheme-media object key>`).
 *
 * A signed-in page that renders for ANY signed-in role (see lib/scheme-photo-link.ts): a signed-out click is sent to
 * sign-in with `next` and lands back here; a role without scheme access, or an account of another programme, reads
 * "You don't have access". The bytes come from the role-gated `/api/schemes/media/file?key=` (tenant pinned from the
 * key's folder). Images are shown full-width, PDFs in an embedded frame, both with Download.
 */
import SignedInMediaViewer, { type MediaViewerConfig } from '@/components/media/SignedInMediaViewer';
import { isSchemeFileKey, schemePhotoMediaUrl } from '@/lib/scheme-photo-link';

function configFor(key: string): MediaViewerConfig {
  const noun = key && isSchemeFileKey(key) ? 'file' : 'photo';
  return {
    heading: noun === 'file' ? 'Scheme file' : 'Scheme photo',
    noun,
    alt: noun === 'file' ? 'Scheme file' : 'Scheme photo',
    noAccessDetail: `Sign in with an account of this programme that can view scheme ${noun}s.`,
    mediaUrl: schemePhotoMediaUrl,
  };
}

export default function SchemePhotoPage() {
  return <SignedInMediaViewer cfg={configFor} />;
}

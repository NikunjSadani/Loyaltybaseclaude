'use client';

/**
 * Visibility photo viewer — the target of the Visibility Excel report's "Open photo" links
 * (`https://<tenant host>/visibility/photo?key=<object key>`).
 *
 * A signed-in page that renders for ANY signed-in role (see lib/visibility-photo-link.ts): a signed-out click is sent
 * to sign-in with `next` and lands back here; a role / tenant without access reads "You don't have access". The image is
 * read from the role-gated `/api/visibility/captures/media?key=` (the backend pins every non-Gifsy caller to its own
 * tenant). The viewer body is shared with the scheme viewer (components/media/SignedInMediaViewer).
 */
import SignedInMediaViewer, { type MediaViewerConfig } from '@/components/media/SignedInMediaViewer';
import { visibilityPhotoMediaUrl } from '@/lib/visibility-photo-link';

const CONFIG: MediaViewerConfig = {
  heading: 'Visibility photo',
  noun: 'photo',
  alt: 'Visibility photo',
  noAccessDetail: 'Sign in with an account of this programme that can view visibility photos.',
  mediaUrl: visibilityPhotoMediaUrl,
};

export default function VisibilityPhotoPage() {
  return <SignedInMediaViewer cfg={CONFIG} />;
}

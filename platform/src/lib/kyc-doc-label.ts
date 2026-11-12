/**
 * Display label for a KYC document of type OTHER.
 *
 * Imported (e.g. Bajaj-migrated) documents all carry documentType OTHER, but their
 * `metadata.label` / `fileName` holds the meaningful name ("Counter photo.jpg",
 * "ID proof (Voter ID).pdf"). Every non-OTHER type keeps its caller's existing label
 * untouched — callers only consult this for OTHER (Deoleo byte-identical).
 */

export const OTHER_DOC_FALLBACK_LABEL = 'Other document';

export interface LabelableKycDoc {
  documentType: string;
  fileName?: string | null;
  metadata?: unknown;
}

function metadataLabel(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const label = (metadata as Record<string, unknown>).label;
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  return trimmed || null;
}

function fileNameLabel(fileName: string | null | undefined): string | null {
  if (typeof fileName !== 'string') return null;
  // Drop any path prefix, then a trailing extension ("Counter photo.jpg" → "Counter photo").
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();
  return stem || null;
}

/** Friendly label for an OTHER document: metadata.label → fileName sans extension → fallback. */
export function otherDocLabel(d: LabelableKycDoc, fallback: string = OTHER_DOC_FALLBACK_LABEL): string {
  return metadataLabel(d.metadata) ?? fileNameLabel(d.fileName) ?? fallback;
}

/**
 * The label to show for any KYC document. Non-OTHER types return `baseLabel(documentType)`
 * unchanged; OTHER resolves via {@link otherDocLabel}.
 */
export function kycDocDisplayLabel(
  d: LabelableKycDoc,
  baseLabel: (documentType: string) => string,
  otherFallback: string = OTHER_DOC_FALLBACK_LABEL,
): string {
  if (d.documentType !== 'OTHER') return baseLabel(d.documentType);
  return otherDocLabel(d, otherFallback);
}

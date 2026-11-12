/**
 * Display label for a KYC document.
 *
 * Imported (e.g. Bajaj-migrated) documents all carry documentType OTHER, with the
 * meaningful name in `metadata.label` ("Counter photo", "Voter ID card"). For type OTHER
 * the label is `metadata.label` ONLY when it is a non-blank string; in every other case
 * (any non-OTHER type, or an OTHER doc without a usable metadata.label — e.g. every
 * existing Deoleo document) the caller's pre-existing label is returned unchanged, so
 * those pages render exactly what they rendered before. fileName is deliberately NOT used.
 */

export interface LabelableKycDoc {
  documentType: string;
  metadata?: unknown;
}

/** metadata.label when it is a non-blank string (trimmed), else null. */
export function metadataLabel(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const label = (metadata as Record<string, unknown>).label;
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  return trimmed || null;
}

/**
 * The label to show for a KYC document: for OTHER with a non-blank metadata.label, that label;
 * otherwise exactly `baseLabel(documentType)` (the page's existing label).
 */
export function kycDocDisplayLabel(
  d: LabelableKycDoc,
  baseLabel: (documentType: string) => string,
): string {
  if (d.documentType === 'OTHER') {
    const fromMeta = metadataLabel(d.metadata);
    if (fromMeta) return fromMeta;
  }
  return baseLabel(d.documentType);
}

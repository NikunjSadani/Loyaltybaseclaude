/**
 * Tiny, dependency-free HTML helpers for the scheduled report emails. Inline styles only
 * (email clients strip <style>/<head>), a neutral table look, and — critically — `esc()` for
 * EVERY dynamic value so a tenant/outlet/rep name can never inject markup into the email.
 */

/** HTML-escape a value for safe interpolation into an email body. Numbers/nullish → clean string. */
export function esc(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Format a paise BigInt/number as "₹1,23,456" (Indian grouping, whole rupees). */
export function rupees(paise: bigint | number): string {
  const rs = typeof paise === 'bigint' ? Number(paise / 100n) : Math.round(Number(paise) / 100);
  return '₹' + rs.toLocaleString('en-IN');
}

/** Format a plain integer with Indian grouping (e.g. points, counts). */
export function intIN(n: number): string {
  return Math.round(n).toLocaleString('en-IN');
}

/**
 * Wrap body HTML in a minimal, email-client-safe shell: a titled card with an intro line and a
 * footer noting it's an automated internal report. All inline-styled.
 */
export function emailShell(opts: { title: string; intro?: string; body: string; dateLabel: string }): string {
  return `<div style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
  <div style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="padding:20px 24px;border-bottom:1px solid #eef0f2;">
      <div style="font-size:18px;font-weight:700;color:#111827;">${esc(opts.title)}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">${esc(opts.dateLabel)}</div>
    </div>
    <div style="padding:20px 24px;">
      ${opts.intro ? `<p style="margin:0 0 16px;font-size:14px;color:#374151;">${esc(opts.intro)}</p>` : ''}
      ${opts.body}
    </div>
    <div style="padding:14px 24px;border-top:1px solid #eef0f2;font-size:12px;color:#9ca3af;">
      Automated internal report from Gifsy. Do not reply.
    </div>
  </div>
</div>`;
}

export interface TableColumn {
  /** Column header text. */
  label: string;
  /** Right-align numeric columns. */
  align?: 'left' | 'right';
}

/**
 * Render an HTML table. `rows` cells are used VERBATIM — callers MUST pass already-escaped/formatted
 * strings (use `esc`, `rupees`, `intIN`). Empty rows → a muted "nothing to show" line.
 */
export function table(cols: TableColumn[], rows: string[][], emptyText = 'Nothing to show.'): string {
  if (rows.length === 0) {
    return `<p style="margin:0;font-size:13px;color:#9ca3af;">${esc(emptyText)}</p>`;
  }
  const th = cols
    .map(
      (c) =>
        `<th style="text-align:${c.align === 'right' ? 'right' : 'left'};padding:8px 10px;font-size:12px;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;text-transform:uppercase;letter-spacing:.03em;">${esc(c.label)}</th>`,
    )
    .join('');
  const trs = rows
    .map(
      (r) =>
        `<tr>${r
          .map(
            (cell, i) =>
              `<td style="text-align:${cols[i]?.align === 'right' ? 'right' : 'left'};padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${cell}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  return `<table style="width:100%;border-collapse:collapse;margin:0 0 8px;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

/** A small heading between sections of a report. */
export function sectionHeading(text: string): string {
  return `<div style="font-size:14px;font-weight:700;color:#111827;margin:20px 0 10px;">${esc(text)}</div>`;
}

/** A row of headline stat pills (label + value), e.g. totals at the top of a report. */
export function statRow(stats: Array<{ label: string; value: string; accent?: 'red' | 'amber' | 'green' }>): string {
  const cell = (s: { label: string; value: string; accent?: 'red' | 'amber' | 'green' }) => {
    const color = s.accent === 'red' ? '#b91c1c' : s.accent === 'amber' ? '#b45309' : s.accent === 'green' ? '#047857' : '#111827';
    return `<td style="padding:12px 14px;background:#f9fafb;border:1px solid #eef0f2;border-radius:8px;">
      <div style="font-size:12px;color:#6b7280;">${esc(s.label)}</div>
      <div style="font-size:20px;font-weight:700;color:${color};margin-top:2px;">${esc(s.value)}</div></td>`;
  };
  return `<table style="width:100%;border-collapse:separate;border-spacing:8px;margin:0 0 4px;"><tr>${stats.map(cell).join('')}</tr></table>`;
}

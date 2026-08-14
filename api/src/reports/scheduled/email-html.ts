/**
 * Tiny, dependency-free HTML helpers for the scheduled report emails. Inline styles for the
 * DESKTOP look (email clients are inline-first), PLUS one embedded `<style>` block in the shell
 * `<head>` carrying a `@media (max-width:480px)` query so clients that honour embedded styles
 * (Apple Mail, iOS/modern Gmail, Outlook mobile app) reflow to a real MOBILE layout — the stat
 * pills stack and the data table collapses into one label:value card per row. Clients that strip
 * `<style>` fall back to the inline desktop layout (which still fits, just squeezed). `esc()` is
 * applied to EVERY dynamic value so a tenant/outlet/rep name can never inject markup.
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
 * Responsive `<style>` for the shell head. Only affects clients that honour embedded styles;
 * everything degrades to the inline desktop layout. Class hooks: `.rpt-card` (the outer card),
 * `.rpt-stats` (the headline pill table), `.rpt-table` (a data table — each `<td>` carries a
 * `data-label` so the mobile card view can prefix "LABEL: value").
 */
const RESPONSIVE_STYLE = `@media only screen and (max-width:480px){
  .rpt-card{border-radius:0!important;border-left:none!important;border-right:none!important}
  .rpt-pad{padding-left:16px!important;padding-right:16px!important}
  /* Headline stat pills → stack one per row */
  .rpt-stats td{display:block!important;width:100%!important;box-sizing:border-box!important;margin:0 0 8px 0!important}
  .rpt-stats{border-spacing:0!important}
  /* Data table → collapse to one label:value card per row */
  .rpt-table thead{display:none!important}
  .rpt-table,.rpt-table tbody,.rpt-table tr,.rpt-table td{display:block!important;width:100%!important;box-sizing:border-box!important}
  .rpt-table tr{padding:10px 0!important;border-bottom:1px solid #eef0f2!important}
  .rpt-table td{text-align:left!important;border:none!important;padding:2px 0!important;font-size:14px!important}
  .rpt-table td:before{content:attr(data-label) ": ";font-weight:600;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:.03em}
  .rpt-table td:first-child{font-weight:700;font-size:15px!important;padding-bottom:4px!important}
  .rpt-table td:first-child:before{content:""}
}`;

/**
 * Wrap body HTML in an email-client-safe document: a viewport-tagged `<head>` with the responsive
 * `<style>`, then a titled card (inline-styled for the desktop/fallback look) with intro + footer.
 */
export function emailShell(opts: { title: string; intro?: string; body: string; dateLabel: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><style>${RESPONSIVE_STYLE}</style></head><body style="margin:0;padding:0;">
<div style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
  <div class="rpt-card" style="max-width:720px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div class="rpt-pad" style="padding:20px 24px;border-bottom:1px solid #eef0f2;">
      <div style="font-size:18px;font-weight:700;color:#111827;">${esc(opts.title)}</div>
      <div style="font-size:13px;color:#6b7280;margin-top:2px;">${esc(opts.dateLabel)}</div>
    </div>
    <div class="rpt-pad" style="padding:20px 24px;">
      ${opts.intro ? `<p style="margin:0 0 16px;font-size:14px;color:#374151;">${esc(opts.intro)}</p>` : ''}
      ${opts.body}
    </div>
    <div class="rpt-pad" style="padding:14px 24px;border-top:1px solid #eef0f2;font-size:12px;color:#9ca3af;">
      Automated internal report from Gifsy. Do not reply.
    </div>
  </div>
</div>
</body></html>`;
}

export interface TableColumn {
  /** Column header text. */
  label: string;
  /** Right-align numeric columns. */
  align?: 'left' | 'right';
}

/**
 * Render an HTML table. `rows` cells are used VERBATIM — callers MUST pass already-escaped/formatted
 * strings (use `esc`, `rupees`, `intIN`). Empty rows → a muted "nothing to show" line. Each `<td>`
 * carries a `data-label` (the column header) so the responsive mobile card view can prefix it.
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
              `<td data-label="${esc(cols[i]?.label ?? '')}" style="text-align:${cols[i]?.align === 'right' ? 'right' : 'left'};padding:8px 10px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">${cell}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('');
  return `<table class="rpt-table" style="width:100%;border-collapse:collapse;margin:0 0 8px;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
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
  return `<table class="rpt-stats" style="width:100%;border-collapse:separate;border-spacing:8px;margin:0 0 4px;"><tr>${stats.map(cell).join('')}</tr></table>`;
}

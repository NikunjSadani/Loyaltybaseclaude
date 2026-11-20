/**
 * The "Remarks needed" email (owner 2026-11-20) — designed around the RECIPIENT (the client admin or
 * the client's ticket-remarks inbox) being able to act without guessing. Pure renderer: the service
 * loads the data (RemarksEmailData) and this builds the subject + HTML. Short, scannable,
 * mobile-friendly: single-column TABLE layout with inline styles (no CSS grid / external CSS).
 *
 * Blocks, in order: THE ASK (highlighted) · button + "reply in the portal" line · TICKET · ISSUE ·
 * OUTLET ("not linked" when none) · RAISED BY (+ a salesperson's reporting manager) · CONTEXT (by
 * category, when cheaply available) · RECENT CONVERSATION (last ≤3 client-visible messages).
 *
 * Privacy: every value is HTML-escaped; free text (note, description, messages) has phone numbers and
 * email addresses masked; no internal ids, no bank / KYC document data, never a Gifsy-only note (the
 * loader only passes client-visible messages). All dates are IST.
 */
import { escapeHtml } from './ticket-link';

export interface RemarksEmailData {
  /** The Gifsy person who asked. */
  askerName: string;
  /** The request note, verbatim (phones / emails masked). */
  note: string;
  askedAt: Date;
  /** The client admin who was asked. */
  askedAdminName: string;
  /** True when the email goes to the client's ticket remarks inbox (not the admin personally). */
  toInbox: boolean;
  link: string;
  now: Date;
  ticket: {
    number: string;
    category: string; // DB enum, e.g. POINTS
    priority: string; // DB enum, e.g. HIGH
    createdAt: Date;
  };
  issue: { subject: string; description: string };
  /** null = no outlet linked; 'unavailable' = lookup failed. */
  outlet:
    | null
    | 'unavailable'
    | {
        code: string;
        name: string;
        type?: string | null;
        program?: string | null;
        subProgram?: string | null;
        city?: string | null;
        state?: string | null;
        kycStatus?: string | null;
        /** Set when the outlet is inferred from the owner (several outlets). */
        note?: string | null;
      };
  raisedBy: { label: string; manager?: string | null } | 'unavailable';
  /** Category context lines (already human); null/empty = no block. */
  context: { heading: string; lines: string[] } | null;
  /** Last ≤3 client-visible messages, oldest first. */
  messages: { who: string; at: Date; text: string }[];
}

export const CATEGORY_LABEL: Record<string, string> = {
  KYC: 'KYC',
  POINTS: 'Points',
  REDEMPTION: 'Redemption',
  PAYOUT: 'Payout',
  SCHEME: 'Scheme',
  TECHNICAL: 'Technical',
  ACCOUNT: 'Account',
  OTHER: 'Other',
};
const PRIORITY_LABEL: Record<string, string> = { LOW: 'Low', MEDIUM: 'Medium', HIGH: 'High', CRITICAL: 'Critical' };

const DESCRIPTION_MAX = 800;
const MESSAGE_MAX = 300;

/** Masks phone numbers (Indian mobiles incl. +91 / 0 prefixes, and any 10+ digit run) and email addresses. */
export function maskContactDetails(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email hidden]')
    .replace(/(?:\+?91[\s-]?|0)?[6-9](?:[\s-]?\d){9}(?!\d)/g, '[phone hidden]')
    .replace(/\d(?:[\s-]?\d){9,}/g, '[number hidden]');
}

function truncate(text: string, max: number, tail: string): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}… ${tail}` : text;
}

/** e.g. "20 Nov 2026, 3:45 pm IST". */
export function istDateTime(d: Date): string {
  return `${d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })} IST`;
}
/** e.g. "20 Nov 2026". */
export function istDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' });
}
function age(createdAt: Date, now: Date): string {
  const days = Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 86_400_000));
  return days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
}

export function remarksEmailSubject(d: Pick<RemarksEmailData, 'ticket' | 'outlet'>): string {
  const outlet = d.outlet && d.outlet !== 'unavailable' ? `Outlet ${d.outlet.code}` : 'no outlet linked';
  return `Remarks needed: ${d.ticket.number} · ${CATEGORY_LABEL[d.ticket.category] ?? d.ticket.category} · ${outlet}`;
}

// ── tiny table-based building blocks (inline styles only) ───────────────────────
const e = escapeHtml;
const FONT = 'font-family:Arial,Helvetica,sans-serif;';
function section(title: string, inner: string): string {
  return `<tr><td style="padding:14px 0 0;${FONT}">`
    + `<div style="font-size:11px;font-weight:bold;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;padding-bottom:4px">${e(title)}</div>`
    + inner + `</td></tr>`;
}
function kv(rows: [string, string][]): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;${FONT}">`
    + rows.map(([k, v]) =>
      `<tr><td style="padding:2px 12px 2px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${e(k)}</td>`
      + `<td style="padding:2px 0;color:#111827;vertical-align:top">${e(v)}</td></tr>`).join('')
    + `</table>`;
}
function para(text: string, style = ''): string {
  return `<p style="margin:0;font-size:14px;line-height:1.5;color:#111827;${FONT}${style}">${e(text).replace(/\n/g, '<br>')}</p>`;
}

export function renderRemarksEmail(d: RemarksEmailData): { subject: string; html: string } {
  const subject = remarksEmailSubject(d);
  const blocks: string[] = [];

  blocks.push(`<tr><td style="padding:0 0 10px;${FONT}">${para(d.toInbox ? 'Hello,' : `Hi ${d.askedAdminName},`)}</td></tr>`);

  // 1. THE ASK — highlighted
  const askMeta = [`Asked on ${istDateTime(d.askedAt)}`, ...(d.toInbox ? [`Asked: ${d.askedAdminName}`] : [])].join(' · ');
  blocks.push(
    `<tr><td style="background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:12px 14px;${FONT}" data-block="ask">`
    + para(`${d.askerName} (Gifsy support) needs your remarks:`, 'font-weight:bold;padding-bottom:6px')
    + para(maskContactDetails(d.note), 'padding-bottom:6px')
    + `<p style="margin:0;font-size:12px;color:#6b7280;${FONT}">${e(askMeta)}</p>`
    + (d.toInbox
      ? `<p style="margin:6px 0 0;font-size:12px;color:#6b7280;${FONT}">Sent to your programme's ticket remarks inbox. ${e(d.askedAdminName)} (or another client admin) can reply in the portal.</p>`
      : '')
    + `</td></tr>`,
  );

  // 2. Button + honest reply line
  blocks.push(
    `<tr><td style="padding:14px 0 0;${FONT}" data-block="action">`
    + `<a href="${e(d.link)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:10px 18px;border-radius:6px">Open ticket &amp; reply</a>`
    + `<p style="margin:8px 0 0;font-size:12px;color:#6b7280">Please reply in the portal — replies to this email are not read.</p>`
    + `</td></tr>`,
  );

  // 3. TICKET
  blocks.push(section('Ticket', kv([
    ['Number', d.ticket.number],
    ['Category', CATEGORY_LABEL[d.ticket.category] ?? d.ticket.category],
    ['Priority', PRIORITY_LABEL[d.ticket.priority] ?? d.ticket.priority],
    ['Status', 'Awaiting your remarks'],
    ['Raised on', `${istDate(d.ticket.createdAt)} (${age(d.ticket.createdAt, d.now)})`],
  ])).replace('<tr>', '<tr data-block="ticket">'));

  // 4. ISSUE
  blocks.push(section('Issue',
    para(d.issue.subject, 'font-weight:bold;padding-bottom:4px')
    + para(truncate(maskContactDetails(d.issue.description), DESCRIPTION_MAX, '(full text in the portal)')),
  ).replace('<tr>', '<tr data-block="issue">'));

  // 5. OUTLET
  if (d.outlet === null) {
    blocks.push(section('Outlet', para('Outlet: not linked')).replace('<tr>', '<tr data-block="outlet">'));
  } else if (d.outlet === 'unavailable') {
    blocks.push(section('Outlet', para('Outlet details are unavailable right now — see the portal.')).replace('<tr>', '<tr data-block="outlet">'));
  } else {
    const o = d.outlet;
    const rows: [string, string][] = [['Outlet', `${o.code} · ${o.name}`]];
    if (o.type) rows.push(['Type', o.type]);
    const prog = [o.program, o.subProgram].filter(Boolean).join(' / ');
    if (prog) rows.push(['Program', prog]);
    const place = [o.city, o.state].filter(Boolean).join(', ');
    if (place) rows.push(['Location', place]);
    rows.push(['KYC', o.kycStatus ?? 'not started']);
    if (o.note) rows.push(['Note', o.note]);
    blocks.push(section('Outlet', kv(rows)).replace('<tr>', '<tr data-block="outlet">'));
  }

  // 6. RAISED BY
  if (d.raisedBy === 'unavailable') {
    blocks.push(section('Raised by', para('Unavailable right now — see the portal.')).replace('<tr>', '<tr data-block="raised-by">'));
  } else {
    const rows: [string, string][] = [['Raised by', d.raisedBy.label]];
    if (d.raisedBy.manager !== undefined) rows.push(['Reports to', d.raisedBy.manager ?? 'no active manager on record']);
    blocks.push(section('Raised by', kv(rows)).replace('<tr>', '<tr data-block="raised-by">'));
  }

  // 7. CONTEXT (category)
  if (d.context && d.context.lines.length > 0) {
    blocks.push(section(d.context.heading, d.context.lines.map((l) => para(l)).join('')).replace('<tr>', '<tr data-block="context">'));
  }

  // 8. RECENT CONVERSATION
  if (d.messages.length > 0) {
    blocks.push(section('Recent conversation', d.messages.map((m) =>
      `<p style="margin:0 0 6px;font-size:13px;line-height:1.45;color:#111827;${FONT}">`
      + `<span style="color:#6b7280">${e(m.who)} · ${e(istDateTime(m.at))}:</span> `
      + `${e(truncate(maskContactDetails(m.text), MESSAGE_MAX, '(more in the portal)')).replace(/\n/g, '<br>')}</p>`).join(''),
    ).replace('<tr>', '<tr data-block="conversation">'));
  }

  blocks.push(
    `<tr><td style="padding:16px 0 0;font-size:11px;color:#9ca3af;${FONT}">`
    + `Your reply is visible to Gifsy support and your admin team only — never to the outlet or sales team.</td></tr>`,
  );

  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:600px;${FONT}">`
    + blocks.join('') + `</table>`;
  return { subject, html };
}

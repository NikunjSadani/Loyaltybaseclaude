/// <reference types="vitest/globals" />
/**
 * Help & Guides: every registered guide is listed on the index and renders in the viewer; the Sales Import guide
 * is registered and quotes the real screen labels it walks through.
 * Run: npx vitest run src/app/admin/guides/__tests__/guides.test.tsx
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const slugRef = vi.hoisted(() => ({ current: 'sales-import' }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ slug: slugRef.current }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import GuidesIndexPage from '../page';
import GuideViewerPage from '../[slug]/page';
import { GUIDES, getGuide } from '@/content/guides';

beforeEach(() => { slugRef.current = 'sales-import'; });

describe('Help & Guides registry', () => {
  it('has unique slugs and every guide has a title, summary, ISO date and body', () => {
    const slugs = GUIDES.map((g) => g.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const g of GUIDES) {
      expect(g.title.trim()).not.toBe('');
      expect(g.summary.trim()).not.toBe('');
      expect(g.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(g.markdown.startsWith(`# ${g.title}`)).toBe(true);
    }
  });

  it('registers the Fund Reconciliation guide', () => {
    expect(getGuide('fund')?.title).toBe('Fund Reconciliation — Step by Step');
  });

  it('registers the Sales Import guide', () => {
    expect(getGuide('sales-import')?.title).toBe('Sales Import — Step by Step');
  });
});

describe('Guides index', () => {
  it('lists every guide, including Sales Import, linking to its page', () => {
    render(<GuidesIndexPage />);
    for (const g of GUIDES) {
      const link = screen.getByRole('link', { name: new RegExp(g.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
      expect(link.getAttribute('href')).toBe(`/admin/guides/${g.slug}`);
    }
    expect(screen.getByRole('link', { name: /Sales Import — Step by Step/ })).toBeTruthy();
  });
});

describe('Guide viewer', () => {
  it('renders the Sales Import guide with its steps and troubleshooting', () => {
    render(<GuideViewerPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Sales Import — Step by Step' })).toBeTruthy();
    for (const h of [
      'Who can do it',
      'Before you start',
      'Step 1 — Upload the file',
      'Step 2 — Processing, and "Needs column mapping"',
      'Step 3 — Read the preview',
      'Step 4 — Apply',
      'Step 5 — Daily files during the month',
      'Step 6 — Recalculate (after a target or KPI change)',
      'Step 7 — Close a month (and reopen it)',
      'What data is kept',
      'Troubleshooting — every message and what to do',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name: h })).toBeTruthy();
    }
    expect(screen.getByRole('heading', { level: 3, name: '"Daily figures not stored for <Month>: <reason>"' })).toBeTruthy();
    expect(screen.getAllByRole('table').length).toBeGreaterThan(5);
    expect(screen.getByText(/Last reviewed 2026-11-18/)).toBeTruthy();
  });

  it('renders every registered guide', () => {
    for (const g of GUIDES) {
      slugRef.current = g.slug;
      const { unmount } = render(<GuideViewerPage />);
      expect(screen.getByRole('heading', { level: 1, name: g.title })).toBeTruthy();
      unmount();
    }
  });

  it('says so for an unknown slug', () => {
    slugRef.current = 'no-such-guide';
    render(<GuideViewerPage />);
    expect(screen.getByText(/That guide doesn.t exist/)).toBeTruthy();
  });
});

describe('Sales Import guide quotes the real screen labels', () => {
  // Each label below is copied from the Sales Import screens (or the dashboard comparison). If a screen's wording
  // changes, update the guide in the same change.
  const md = getGuide('sales-import')!.markdown;
  it.each([
    'Upload a sales file',
    'Resume upload (N% sent)',
    'Discard this upload',
    'Needs column mapping',
    'The portal could not find the columns it needs',
    'Set up column mapping',
    'Save column mapping',
    'Reprocess',
    'Read again as a new import',
    'Find it automatically (rows 1–10)',
    'Months in this file',
    'Outlets found',
    'Not in programme',
    'Refresh preview',
    'Older data than last applied',
    'Starts after the 1st',
    'Ends before month end',
    'Replaces manual values',
    'Negative values',
    'Column settings changed',
    'Accept — not sold yet',
    'Targets changed — recalculate',
    'A Gifsy admin must reopen this month first',
    'Rebuild product list',
    'Repeat file',
    'Daily figures not stored for <Month>',
    'vs last month (to day N)',
    'vs 3-month average (to day N)',
    'Monthly billing progress',
    'Sales Import is not enabled',
  ])('mentions "%s"', (label) => {
    expect(md).toContain(label);
  });

  it('does not promise specific retention day counts for uploaded files or month history', () => {
    expect(md).not.toMatch(/\b(7|30)\s*days\b/);
    expect(md).not.toMatch(/10 years/);
  });
});

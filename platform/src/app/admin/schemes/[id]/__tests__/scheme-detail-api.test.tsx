/// <reference types="vitest/globals" />
/**
 * ASID — Admin Scheme detail page (data-collection rework)
 *
 * The detail page is now a thin shell:
 *   /admin/schemes/new  → the create form
 *   /admin/schemes/:id  → <SchemeManager> (its own round-trip fetch) + quick links
 *
 * ASID1: existing scheme → renders the SchemeManager + management quick-links
 * ASID2: 'new' → renders the create form (no manager, no links)
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Stub the manager so we test the page shell (the manager has its own tests via
// its sub-components / the shared client). Renders a marker + the scheme id.
vi.mock('@/components/admin/SchemeManager', () => ({
  SchemeManager: ({ schemeId }: { schemeId: string }) => <div data-testid="scheme-manager">manager:{schemeId}</div>,
}));

// Configurable id for the react `use(params)` unwrap.
let CURRENT_ID = 'SCH001';
vi.mock('react', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('react');
  return {
    ...actual,
    use: (val: unknown) => {
      if (val && typeof val === 'object' && 'then' in (val as object)) return { id: CURRENT_ID };
      return actual.use(val as never);
    },
  };
});

import SchemeDetailPage from '../page';

describe('ASID — Admin Scheme detail page', () => {
  it('ASID1: existing scheme renders the manager + quick links', () => {
    CURRENT_ID = 'SCH001';
    render(<SchemeDetailPage params={Promise.resolve({ id: 'SCH001' })} />);
    expect(screen.getByTestId('scheme-manager')).toHaveTextContent('manager:SCH001');
    expect(screen.getByText('Enrollments')).toBeInTheDocument();
    expect(screen.getByText('Broadcast')).toBeInTheDocument();
    expect(screen.getByText('Report')).toBeInTheDocument();
  });

  it('ASID2: new scheme renders the create form, not the manager', () => {
    CURRENT_ID = 'new';
    render(<SchemeDetailPage params={Promise.resolve({ id: 'new' })} />);
    expect(screen.queryByTestId('scheme-manager')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create scheme/i })).toBeInTheDocument();
    expect(screen.getByText('Create as')).toBeInTheDocument();
  });
});

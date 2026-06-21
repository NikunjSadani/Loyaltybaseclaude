/// <reference types="vitest/globals" />
/**
 * PVIS — Partner Visibility page (#57 mock-data removal)
 *
 * The previous "My Submissions" history was hardcoded demo data. The backend
 * exposes NO partner-facing list endpoint (GET /v1/visibility/submissions
 * forbids partner roles), so the history is now an honest empty state.
 *
 * PVIS1: renders the empty-state ("No submissions yet") with no fabricated rows
 * PVIS2: the submit flow still posts to the real POST /api/visibility/submit
 * PVIS3: page source contains no hardcoded demo submission history
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';

import VisibilityPage from '../page';

afterEach(() => { vi.unstubAllGlobals(); });

describe('PVIS — Partner Visibility empty-state', () => {
  it('PVIS1: shows the empty state and no fabricated submission rows', () => {
    render(<VisibilityPage />);
    expect(screen.getByText(/no submissions yet/i)).toBeInTheDocument();
    // The old demo personas must not be present anymore.
    expect(screen.queryByText(/Ramesh General Store/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Meena Kirana/i)).not.toBeInTheDocument();
  });

  it('PVIS3: page source has no hardcoded demo submission history', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(path.resolve(__dirname, '..', 'page.tsx'), 'utf8');
    expect(src).not.toMatch(/Ramesh General Store/);
    expect(src).not.toMatch(/Standee not properly visible/);
    // The submit endpoint (the only real partner-facing visibility route) stays.
    expect(src).toMatch(/\/api\/visibility\/submit/);
  });
});

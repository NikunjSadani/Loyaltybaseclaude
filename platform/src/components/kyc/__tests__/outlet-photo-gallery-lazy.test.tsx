/// <reference types="vitest/globals" />
/**
 * TDD — OutletPhotoGallery: lazy "View Photos" button (saves bandwidth)
 *
 * S1: No <img> auto-loads on mount — thumbnails must NOT appear until user clicks
 * S2: A "View Photos (N)" button is rendered with data-testid="outlet-photo-view-btn"
 * S3: The button text includes the exact photo count
 * S4: Clicking the button opens the photo lightbox (data-testid="outlet-photo-lightbox")
 * S5: After opening, the photos are in the DOM as <img> elements
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { OutletPhotoGallery } from '../outlet-photo-gallery';

const MOCK_PHOTOS = [
  { id: 'p1', fileUrl: 'https://example.com/photo1.jpg', documentType: 'OUTLET_PHOTO',       createdAt: '2026-01-01' },
  { id: 'p2', fileUrl: 'https://example.com/photo2.jpg', documentType: 'OUTLET_PHOTO',       createdAt: '2026-01-02' },
  { id: 'p3', fileUrl: 'https://example.com/photo3.jpg', documentType: 'SHOP_ESTABLISHMENT', createdAt: '2026-01-03' },
];

describe('S — OutletPhotoGallery: lazy photo loading', () => {
  it('S1: no <img> elements are auto-loaded on mount (no inline thumbnails)', () => {
    render(<OutletPhotoGallery photos={MOCK_PHOTOS} />);
    // Before any click, zero images should be in the DOM
    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('S2: a "View Photos" button with a data-testid is rendered', () => {
    render(<OutletPhotoGallery photos={MOCK_PHOTOS} />);
    const btn = screen.getByTestId('outlet-photo-view-btn');
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toMatch(/view photos/i);
  });

  it('S3: the button label includes the count of photos', () => {
    render(<OutletPhotoGallery photos={MOCK_PHOTOS} />);
    const btn = screen.getByTestId('outlet-photo-view-btn');
    expect(btn.textContent).toMatch(/3/);
  });

  it('S4: clicking the button opens the photo lightbox', () => {
    render(<OutletPhotoGallery photos={MOCK_PHOTOS} />);
    expect(screen.queryByTestId('outlet-photo-lightbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('outlet-photo-view-btn'));
    expect(screen.getByTestId('outlet-photo-lightbox')).toBeInTheDocument();
  });

  it('S5: after opening, at least one photo is rendered as an <img>', () => {
    render(<OutletPhotoGallery photos={MOCK_PHOTOS} />);
    fireEvent.click(screen.getByTestId('outlet-photo-view-btn'));
    expect(screen.getAllByRole('img').length).toBeGreaterThanOrEqual(1);
  });
});

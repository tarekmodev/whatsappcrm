import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageShell } from './PageShell';

/**
 * `data-page-shell="fill"` is not decoration: `AppShell` reads it with `:has()`
 * to stop the frame growing with its content, and that is the only channel
 * between a page and the frame around it. A rename here is a silently scrolling
 * workspace, which is the defect the variant exists to remove.
 */
describe('PageShell', () => {
  it('flows by default, with no seam for the frame to read', () => {
    render(
      <PageShell>
        <p>Section</p>
      </PageShell>,
    );

    expect(document.querySelector('[data-page-shell]')).toBeNull();
    expect(screen.getByText('Section')).toBeInTheDocument();
  });

  it('marks the fill variant with the attribute AppShell reads', () => {
    render(
      <PageShell variant="fill">
        <p>Workspace</p>
      </PageShell>,
    );

    const shell = document.querySelector('[data-page-shell]');

    expect(shell).toHaveAttribute('data-page-shell', 'fill');
    expect(shell).toContainElement(screen.getByText('Workspace'));
  });

  it('takes the workspace child directly, with no container or rhythm wrapper around it', () => {
    render(
      <PageShell variant="fill">
        <p>Workspace</p>
      </PageShell>,
    );

    // The cap, the gutter and the vertical rhythm are what fill mode drops; the
    // child is the shell's own, not something nested two boxes deep.
    expect(screen.getByText('Workspace').parentElement).toHaveAttribute('data-page-shell', 'fill');
  });
});

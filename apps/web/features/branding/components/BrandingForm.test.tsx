import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BRANDING_DEFAULTS, type TenantBranding } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { testBranding } from '@/lib/testing/branding';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { BrandingForm } from './BrandingForm';

// The mock is typed against the action's real signature, so a test cannot go on
// passing while the action it stands in for changes shape.
const saveBrandingAction = vi.fn<(input: unknown) => Promise<ActionResult<TenantBranding>>>();

vi.mock('../branding.actions', () => ({
  saveBrandingAction: (input: unknown) => saveBrandingAction(input),
}));

/**
 * The preview is behind `next/dynamic` with `ssr: false`, which in jsdom resolves
 * asynchronously and would make every assertion below race a chunk load. It has
 * its own coverage through `brandCssVariables`; what this file is about is the
 * form.
 */
vi.mock('./branding-widgets.lazy', () => ({
  LazyBrandingPreview: () => null,
}));

const SAVED = testBranding({
  productName: 'Northwind Support',
  primaryColor: '#0f6fde',
  accentColor: '#7c3aed',
  supportEmail: 'help@northwind.example',
});

function renderForm() {
  return render(
    <ToastProvider>
      <BrandingForm branding={SAVED} theme="light" />
    </ToastProvider>,
  );
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: content.common.save }));
}

describe('BrandingForm', () => {
  beforeEach(() => {
    saveBrandingAction.mockReset();
    saveBrandingAction.mockResolvedValue({ status: 'success', data: SAVED });
  });

  it('starts from the tenant’s saved branding rather than the platform default', () => {
    renderForm();

    expect(fieldByLabel(content.branding.productNameLabel)).toHaveValue('Northwind Support');
    expect(fieldByLabel(content.branding.hexLabel(content.branding.primaryColorLabel))).toHaveValue(
      '#0f6fde',
    );
  });

  it('sends the trimmed, lower-cased values under the contract’s names', async () => {
    renderForm();

    fireEvent.change(fieldByLabel(content.branding.productNameLabel), {
      target: { value: '  Acme Support  ' },
    });
    fireEvent.change(fieldByLabel(content.branding.hexLabel(content.branding.primaryColorLabel)), {
      target: { value: '#B3261E' },
    });
    save();

    await waitFor(() => {
      expect(saveBrandingAction).toHaveBeenCalledWith({
        productName: 'Acme Support',
        primaryColor: '#b3261e',
        accentColor: '#7c3aed',
        supportEmail: 'help@northwind.example',
      });
    });
  });

  it('sends null for a cleared support email, not an empty string', async () => {
    renderForm();

    fireEvent.change(fieldByLabel(content.branding.supportEmailLabel), { target: { value: '' } });
    save();

    await waitFor(() => {
      expect(saveBrandingAction).toHaveBeenCalledWith(
        expect.objectContaining({ supportEmail: null }),
      );
    });
  });

  it('refuses a colour that is not a hex value, and does not call the action', async () => {
    renderForm();

    fireEvent.change(fieldByLabel(content.branding.hexLabel(content.branding.primaryColorLabel)), {
      target: { value: 'cornflower' },
    });
    save();

    expect(await screen.findByText(content.branding.colorInvalid)).toBeInTheDocument();
    expect(saveBrandingAction).not.toHaveBeenCalled();
  });

  it('refuses an empty product name', async () => {
    renderForm();

    fireEvent.change(fieldByLabel(content.branding.productNameLabel), { target: { value: '   ' } });
    save();

    expect(await screen.findByText(content.branding.productNameRequired)).toBeInTheDocument();
    expect(saveBrandingAction).not.toHaveBeenCalled();
  });

  it('keeps what the user typed when the save fails', async () => {
    saveBrandingAction.mockResolvedValue({
      status: 'error',
      message: 'Nope',
      requestId: 'req-1',
    });

    renderForm();

    fireEvent.change(fieldByLabel(content.branding.productNameLabel), {
      target: { value: 'Half-finished rename' },
    });
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent('Nope');
    // A failed submit must never make somebody retype their work.
    expect(fieldByLabel(content.branding.productNameLabel)).toHaveValue('Half-finished rename');
  });

  it('reports what a colour scores without refusing it', async () => {
    renderForm();

    // A pale yellow: legible only because the console corrects the text on it.
    fireEvent.change(fieldByLabel(content.branding.hexLabel(content.branding.primaryColorLabel)), {
      target: { value: '#fef08a' },
    });

    expect(
      await screen.findByText(new RegExp(content.branding.contrastAdjusted)),
    ).toBeInTheDocument();

    save();

    // Reported, never enforced — the derivation guarantees AA whatever is picked.
    await waitFor(() => {
      expect(saveBrandingAction).toHaveBeenCalledWith(
        expect.objectContaining({ primaryColor: '#fef08a' }),
      );
    });
  });

  it('puts the platform colours back when the reset is pressed', () => {
    renderForm();

    fireEvent.click(screen.getByRole('button', { name: content.branding.resetColours }));

    // The constant rather than a copy of it: the platform accent moved with the
    // Reqta palette port (TAR-801), and a literal here would have pinned the test
    // to the colour instead of to the behaviour it is about.
    expect(fieldByLabel(content.branding.hexLabel(content.branding.primaryColorLabel))).toHaveValue(
      BRANDING_DEFAULTS.primaryColor,
    );
  });
});

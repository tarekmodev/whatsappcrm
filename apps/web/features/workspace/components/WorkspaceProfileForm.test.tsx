import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TenantResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { WorkspaceProfileForm } from './WorkspaceProfileForm';

/**
 * TAR-409's first acceptance criterion at the control level: a tenant admin can
 * see and change the workspace name and its contact address.
 *
 * The two things worth pinning are the ones a reviewer cannot see by looking:
 * that an emptied support address is sent as `null` rather than as `''` — the
 * contract's `supportEmail` is nullable and `''` fails its `z.email()` — and
 * that a failed submit keeps every value the user typed.
 */

const updateWorkspaceProfileAction = vi.fn();

vi.mock('@/features/workspace/workspace.actions', () => ({
  updateWorkspaceProfileAction: (...args: unknown[]) =>
    updateWorkspaceProfileAction(...args) as unknown,
}));

const TENANT: TenantResponse = {
  id: '0192f000-0000-7000-8000-00000000a001',
  name: 'Northwind Traders',
  slug: 'northwind',
  status: 'trialing',
  branding: {
    productName: 'Northwind Support',
    primaryColor: '#16a34a',
    accentColor: '#15803d',
    supportEmail: 'support@northwind.example',
    logo: null,
    favicon: null,
  },
  domains: [
    {
      id: '0192f00e-0000-7000-8000-000000000e01',
      hostname: 'northwind.app.example.com',
      // `platform`, not `platform_subdomain`: the wire value is the database
      // enum value, corrected when TAR-416's contract landed.
      kind: 'platform',
      status: 'live',
      isPrimary: true,
      verifiedAt: '2026-07-01T09:00:00.000Z',
      activatedAt: '2026-07-01T09:05:00.000Z',
      verification: null,
      routing: null,
      createdAt: '2026-07-01T09:00:00.000Z',
    },
  ],
  trialEndsAt: null,
  createdAt: '2026-07-01T09:00:00.000Z',
};

function renderForm(tenant: TenantResponse = TENANT) {
  return render(
    <ToastProvider>
      <WorkspaceProfileForm tenant={tenant} />
    </ToastProvider>,
  );
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: content.workspace.saveProfile }));
}

beforeEach(() => {
  updateWorkspaceProfileAction.mockReset();
  updateWorkspaceProfileAction.mockResolvedValue({ status: 'success', data: TENANT });
});

describe('WorkspaceProfileForm', () => {
  it('opens with the workspace’s current values', () => {
    renderForm();

    expect(fieldByLabel(content.workspace.nameLabel)).toHaveValue(TENANT.name);
    expect(fieldByLabel(content.workspace.supportEmailLabel)).toHaveValue(
      'support@northwind.example',
    );
  });

  /**
   * The address is text, not a disabled input: the slug it is built from is
   * immutable by contract, and a disabled control both reads as "not right now"
   * and is skipped by keyboard navigation.
   */
  it('shows the workspace address as text rather than as a control', () => {
    renderForm();

    expect(screen.getByText('northwind.app.example.com')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('northwind.app.example.com')).not.toBeInTheDocument();
  });

  it('sends a partial body, so the colours it never showed cannot be clobbered', async () => {
    renderForm();

    fireEvent.change(fieldByLabel(content.workspace.nameLabel), {
      target: { value: 'Northwind Support Co' },
    });
    save();

    await waitFor(() => {
      expect(updateWorkspaceProfileAction).toHaveBeenCalledWith({
        name: 'Northwind Support Co',
        branding: { supportEmail: 'support@northwind.example' },
      });
    });
  });

  it('sends null for an emptied support address, not an empty string', async () => {
    renderForm();

    fireEvent.change(fieldByLabel(content.workspace.supportEmailLabel), {
      target: { value: '' },
    });
    save();

    await waitFor(() => {
      expect(updateWorkspaceProfileAction).toHaveBeenCalledWith({
        name: TENANT.name,
        branding: { supportEmail: null },
      });
    });
  });

  it('refuses to submit an empty name, and says so next to the field', async () => {
    renderForm();

    fireEvent.change(fieldByLabel(content.workspace.nameLabel), { target: { value: '  ' } });
    save();

    expect(await screen.findByText(content.workspace.nameRequiredError)).toBeInTheDocument();
    expect(updateWorkspaceProfileAction).not.toHaveBeenCalled();
  });

  it('confirms a save with a toast', async () => {
    renderForm();
    save();

    expect(await screen.findByText(content.workspace.profileSavedToast)).toBeInTheDocument();
  });

  it('keeps every value the user typed when the save fails', async () => {
    updateWorkspaceProfileAction.mockResolvedValue({
      status: 'error',
      message: content.form.genericSubmitError,
      requestId: 'req-1',
    });

    renderForm();
    fireEvent.change(fieldByLabel(content.workspace.nameLabel), {
      target: { value: 'Half typed' },
    });
    save();

    expect(await screen.findByRole('alert')).toHaveTextContent(content.form.genericSubmitError);
    expect(fieldByLabel(content.workspace.nameLabel)).toHaveValue('Half typed');
    expect(fieldByLabel(content.workspace.supportEmailLabel)).toHaveValue(
      'support@northwind.example',
    );
  });
});

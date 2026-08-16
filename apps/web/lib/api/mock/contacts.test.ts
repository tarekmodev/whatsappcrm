import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContactResponse,
  CursorPage,
  CustomFieldDefinition,
  TenantRole,
} from '@whatsappcrm/contracts';

/**
 * The contacts half of the mock transport (TAR-33), tested directly because it
 * is the only place 0002 amendment 10's rules can be exercised end to end before
 * the backend lands: the merge, the explicit clear, the immutability of `key`
 * and `type`, and what a delete does to the values behind it.
 *
 * A file of its own rather than more cases in `handlers.test.ts`, which is
 * already 1700 lines and covers a different set of resources.
 *
 * `server-only` throws outside a React Server Component, and `next/headers`
 * needs a request scope — both are stubbed so these stay plain unit tests.
 */

vi.mock('server-only', () => ({}));

let currentRole: TenantRole = 'admin';

vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (name === 'wac_role_stub' ? { name, value: currentRole } : undefined),
    }),
}));

const { handleMockRequest } = await import('./handlers');
const { resetMockState } = await import('./store');
const { MOCK_IDS } = await import('./fixtures');

function asRole(role: TenantRole): void {
  currentRole = role;
}

beforeEach(() => {
  resetMockState();
  asRole('admin');
});

describe('contact directory', () => {
  it('never returns another tenant’s contacts', async () => {
    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/contacts?limit=100',
    })) as CursorPage<ContactResponse>;

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.map((contact) => contact.id)).not.toContain(MOCK_IDS.contacts.otherTenant);
  });

  it('answers 404 — never 403 — for a contact in another tenant', async () => {
    // The two are indistinguishable by design, so nothing can be enumerated
    // across tenants.
    await expect(
      handleMockRequest({
        method: 'GET',
        path: `/v1/contacts/${MOCK_IDS.contacts.otherTenant}`,
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('narrows the list to one tag', async () => {
    const page = (await handleMockRequest({
      method: 'GET',
      path: `/v1/contacts?limit=100&tagId=${MOCK_IDS.tags.vip}`,
    })) as CursorPage<ContactResponse>;

    expect(page.items.length).toBeGreaterThan(0);
    expect(
      page.items.every((contact) => contact.tags.some((tag) => tag.id === MOCK_IDS.tags.vip)),
    ).toBe(true);
  });

  it('matches `q` against name, phone and email', async () => {
    const byName = (await handleMockRequest({
      method: 'GET',
      path: '/v1/contacts?limit=100&q=fatima',
    })) as CursorPage<ContactResponse>;
    const byPhone = (await handleMockRequest({
      method: 'GET',
      path: '/v1/contacts?limit=100&q=%2B966501234567',
    })) as CursorPage<ContactResponse>;
    const byEmail = (await handleMockRequest({
      method: 'GET',
      path: '/v1/contacts?limit=100&q=karim.nasser',
    })) as CursorPage<ContactResponse>;

    expect(byName.items.map((contact) => contact.id)).toEqual([MOCK_IDS.contacts.fatima]);
    expect(byPhone.items.map((contact) => contact.id)).toEqual([MOCK_IDS.contacts.fatima]);
    expect(byEmail.items.map((contact) => contact.id)).toEqual([MOCK_IDS.contacts.karim]);
  });

  it('lets an agent read and write a contact — both are agent-level permissions', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({ method: 'GET', path: `/v1/contacts/${MOCK_IDS.contacts.fatima}` }),
    ).resolves.toMatchObject({ id: MOCK_IDS.contacts.fatima });

    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/contacts/${MOCK_IDS.contacts.fatima}`,
        body: { tagIds: [] },
      }),
    ).resolves.toMatchObject({ tags: [] });
  });

  it('refuses a tag from another tenant with a 404', async () => {
    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/contacts/${MOCK_IDS.contacts.fatima}`,
        body: { tagIds: [MOCK_IDS.tags.otherTenant] },
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('keeps the snapshot a conversation embeds in step with the contact', async () => {
    await handleMockRequest({
      method: 'PATCH',
      path: `/v1/contacts/${MOCK_IDS.contacts.fatima}`,
      body: { tagIds: [] },
    });

    const conversation = (await handleMockRequest({
      method: 'GET',
      path: `/v1/conversations/${MOCK_IDS.conversations.assignedToAmina}`,
    })) as { contact: ContactResponse };

    expect(conversation.contact.tags).toEqual([]);
  });
});

describe('custom field values on a contact', () => {
  /**
   * Amendment 10: a `customFields` write is a **merge**. Replacement would make
   * an agent editing one field silently erase every value their form did not
   * happen to load.
   */
  it('merges a write instead of replacing the map', async () => {
    const updated = (await handleMockRequest({
      method: 'PATCH',
      path: `/v1/contacts/${MOCK_IDS.contacts.fatima}`,
      body: { customFields: { account_manager: 'Liang Wei' } },
    })) as ContactResponse;

    expect(updated.customFields).toEqual({ plan_tier: 'gold', account_manager: 'Liang Wei' });
  });

  it('clears exactly one field for an explicit null, leaving the key absent', async () => {
    // Absent, not `null`: a response carries only the keys the contact has a
    // value for.
    const updated = (await handleMockRequest({
      method: 'PATCH',
      path: `/v1/contacts/${MOCK_IDS.contacts.fatima}`,
      body: { customFields: { plan_tier: null } },
    })) as ContactResponse;

    expect(updated.customFields).toEqual({ account_manager: 'Priya Raman' });
    expect('plan_tier' in updated.customFields).toBe(false);
  });

  it('refuses a value its definition would not accept', async () => {
    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/contacts/${MOCK_IDS.contacts.fatima}`,
        body: { customFields: { plan_tier: 'titanium' } },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
  });

  it('refuses a key no definition claims rather than silently dropping it', async () => {
    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/contacts/${MOCK_IDS.contacts.fatima}`,
        body: { customFields: { not_a_field: 'x' } },
      }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
  });

  it('leaves a stale select value untouched while another field is written', async () => {
    // Jonas holds `plan_tier: 'platinum'`, which the definition no longer
    // offers. Amendment 10 keeps it until that field is next written.
    const updated = (await handleMockRequest({
      method: 'PATCH',
      path: `/v1/contacts/${MOCK_IDS.contacts.jonas}`,
      body: { customFields: { account_manager: 'Noor Rahman' } },
    })) as ContactResponse;

    expect(updated.customFields.plan_tier).toBe('platinum');
  });
});

describe('custom field definitions', () => {
  /**
   * Amendment 10's permission split. `contact:write` cannot carry the write half
   * — every agent holds it, which is TAR-33's criterion inverted — so mutating
   * takes `tenant:settings`, which only an admin has.
   */
  it('lets every role list the definitions but only an admin mutate them', async () => {
    asRole('agent');

    await expect(
      handleMockRequest({ method: 'GET', path: '/v1/custom-fields?limit=100' }),
    ).resolves.toBeTruthy();

    await expect(
      handleMockRequest({
        method: 'POST',
        path: '/v1/custom-fields',
        body: { label: 'Nope', key: 'nope', type: 'text', options: [] },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });

    asRole('supervisor');

    await expect(
      handleMockRequest({
        method: 'DELETE',
        path: `/v1/custom-fields/${MOCK_IDS.customFields.planTier}`,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('assigns position server-side, after every existing field', async () => {
    const created = (await handleMockRequest({
      method: 'POST',
      path: '/v1/custom-fields',
      body: { label: 'Renews on', key: 'renews_on', type: 'date', options: [] },
    })) as CustomFieldDefinition;

    expect(created.position).toBe(2);

    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/custom-fields?limit=100',
    })) as CursorPage<CustomFieldDefinition>;

    expect(page.items.map((definition) => definition.key)).toEqual([
      'plan_tier',
      'account_manager',
      'renews_on',
    ]);
  });

  it('refuses a duplicate key with a conflict, because the key is unique per tenant', async () => {
    await expect(
      handleMockRequest({
        method: 'POST',
        path: '/v1/custom-fields',
        body: { label: 'Another plan tier', key: 'plan_tier', type: 'text', options: [] },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('renames a field and edits its options, leaving key and type alone', async () => {
    const updated = (await handleMockRequest({
      method: 'PATCH',
      path: `/v1/custom-fields/${MOCK_IDS.customFields.planTier}`,
      body: { label: 'Subscription tier', options: ['bronze', 'gold'] },
    })) as CustomFieldDefinition;

    expect(updated).toMatchObject({
      label: 'Subscription tier',
      key: 'plan_tier',
      type: 'select',
      options: ['bronze', 'gold'],
    });
  });

  it('refuses a body that carries neither label nor options', async () => {
    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/custom-fields/${MOCK_IDS.customFields.planTier}`,
        body: {},
      }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
  });

  /**
   * Removing an option rewrites no contact: a stored value outside the current
   * list survives until that field is next written. The profile renders it
   * as-is; it is stale, not corrupt.
   */
  it('leaves a contact holding an option that was just removed', async () => {
    await handleMockRequest({
      method: 'PATCH',
      path: `/v1/custom-fields/${MOCK_IDS.customFields.planTier}`,
      body: { options: ['bronze', 'silver'] },
    });

    const contact = (await handleMockRequest({
      method: 'GET',
      path: `/v1/contacts/${MOCK_IDS.contacts.fatima}`,
    })) as ContactResponse;

    expect(contact.customFields.plan_tier).toBe('gold');
  });

  /**
   * Amendment 10: delete strips the values in the same transaction. Leaving them
   * orphaned means an admin who re-creates the same key later gets every old
   * value back, on a screen giving no hint they were ever there.
   */
  it('strips the key from every contact in the tenant when the definition is deleted', async () => {
    await handleMockRequest({
      method: 'DELETE',
      path: `/v1/custom-fields/${MOCK_IDS.customFields.accountManager}`,
    });

    const page = (await handleMockRequest({
      method: 'GET',
      path: '/v1/contacts?limit=100',
    })) as CursorPage<ContactResponse>;

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((contact) => !('account_manager' in contact.customFields))).toBe(true);
  });

  it('refuses to delete a field a routing rule still names', async () => {
    // The seeded `VIP onboarding` rule carries a `contact_attribute` condition
    // on `plan_tier`. A rule whose condition can never match again is the
    // silent-failure mode amendment 10 exists to prevent, so the delete is
    // refused and the admin disables the rule first.
    await expect(
      handleMockRequest({
        method: 'DELETE',
        path: `/v1/custom-fields/${MOCK_IDS.customFields.planTier}`,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('answers 404 for a definition in another tenant', async () => {
    await expect(
      handleMockRequest({
        method: 'PATCH',
        path: `/v1/custom-fields/${MOCK_IDS.customFields.otherTenant}`,
        body: { label: 'Stolen' },
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});

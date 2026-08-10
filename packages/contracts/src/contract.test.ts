import { describe, expect, it } from 'vitest';
import { PROVISIONED_TENANT_STATUSES, ProvisionTenantInputSchema } from './admin';
import { IanaTimezoneSchema, PhoneE164Schema } from './common';
import { API_ERROR_CODES, API_ERROR_STATUS, httpStatusForErrorCode } from './error-codes';
import { isMessageStatusAdvance, SendMessageInputSchema } from './messages';
import {
  isRoleWithin,
  permissionsForRole,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  roleHasPermission,
  TENANT_ROLES,
} from './rbac';
import { canTransitionTenant, TENANT_STATUSES, TENANT_STATUS_EFFECTS } from './tenant';
import { USAGE_METRIC_KINDS, USAGE_METRICS } from './usage';
import { AvailabilityUpdateInputSchema, USER_STATUSES, UserUpdateInputSchema } from './users';
import { MessageTemplateResponseSchema, WhatsAppBusinessAccountResponseSchema } from './whatsapp';

describe('error taxonomy', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_STATUS[code], code).toBeGreaterThanOrEqual(400);
    }
  });

  it('never answers 2xx for an error', () => {
    expect(httpStatusForErrorCode('not_found')).toBe(404);
    expect(httpStatusForErrorCode('plan_limit_exceeded')).toBe(402);
  });
});

describe('role permissions', () => {
  it('gives every role a permission set', () => {
    for (const role of TENANT_ROLES) {
      expect(permissionsForRole(role).length, role).toBeGreaterThan(0);
    }
  });

  it('widens monotonically from agent to supervisor to admin', () => {
    for (const permission of ROLE_PERMISSIONS.agent) {
      expect(roleHasPermission('supervisor', permission), permission).toBe(true);
    }
    for (const permission of ROLE_PERMISSIONS.supervisor) {
      expect(roleHasPermission('admin', permission), permission).toBe(true);
    }
  });

  it('does not let an agent read the whole tenant or touch billing', () => {
    expect(roleHasPermission('agent', 'conversation:read_all')).toBe(false);
    expect(roleHasPermission('agent', 'billing:manage')).toBe(false);
    expect(roleHasPermission('supervisor', 'billing:manage')).toBe(false);
  });

  // TAR-79, delta 1. The escalation path this closes was live in the shipped
  // table: a supervisor holding `user:invite` could invite an admin, and one
  // holding `user:update` could promote themselves.
  it('keeps role assignment admin-only, separately from user administration', () => {
    expect(roleHasPermission('supervisor', 'user:update')).toBe(true);
    expect(roleHasPermission('supervisor', 'user:set_role')).toBe(false);
    expect(roleHasPermission('agent', 'user:update')).toBe(false);
    expect(roleHasPermission('admin', 'user:set_role')).toBe(true);
  });

  // TAR-79, delta 2. Suspension covers "cut their access now"; deletion is
  // irreversible and changes seat billing, so it stays with admin.
  it('lets a supervisor suspend but not remove', () => {
    expect(roleHasPermission('supervisor', 'user:update')).toBe(true);
    expect(roleHasPermission('supervisor', 'user:remove')).toBe(false);
    expect(roleHasPermission('admin', 'user:remove')).toBe(true);
  });

  it('gives an admin every permission, so a new one never needs a second edit', () => {
    for (const permission of PERMISSIONS) {
      expect(roleHasPermission('admin', permission), permission).toBe(true);
    }
  });

  // The failure mode from TAR-79's operations table: a permission granted to
  // nobody makes its endpoint unreachable except by admin, silently.
  it('leaves no permission unreachable by every role', () => {
    for (const permission of PERMISSIONS) {
      const holders = TENANT_ROLES.filter((role) => roleHasPermission(role, permission));

      expect(holders.length, permission).toBeGreaterThan(0);
    }
  });

  it('orders roles so nobody can grant above their own', () => {
    expect(isRoleWithin('agent', 'supervisor')).toBe(true);
    expect(isRoleWithin('supervisor', 'supervisor')).toBe(true);
    expect(isRoleWithin('admin', 'supervisor')).toBe(false);
    expect(isRoleWithin('admin', 'admin')).toBe(true);
  });
});

describe('user lifecycle statuses', () => {
  // The drift TAR-80 closed on `user_role` by deleting `owner`, in the other
  // direction: `removed` exists in the column and had no contract spelling, so
  // a removed user would have failed response validation and answered 500.
  it('publishes every status the column can hold', () => {
    expect(USER_STATUSES).toEqual(['invited', 'active', 'suspended', 'removed']);
  });

  it('refuses to let a PATCH set the two statuses that are operations', () => {
    // `invited` belongs to the invite flow, `removed` to admin-only
    // `DELETE /users/{id}`. Accepting either here would let a supervisor
    // holding `user:update` remove somebody through the side door.
    expect(UserUpdateInputSchema.parse({ status: 'suspended' }).status).toBe('suspended');
    expect(() => UserUpdateInputSchema.parse({ status: 'removed' })).toThrow();
    expect(() => UserUpdateInputSchema.parse({ status: 'invited' })).toThrow();
  });

  it('strips a client-supplied role from an availability update', () => {
    // The one route with no permission attached. A body that could smuggle a
    // role into it would be the cheapest escalation in the API.
    const parsed = AvailabilityUpdateInputSchema.parse({ availability: 'away', role: 'admin' });

    expect(parsed).not.toHaveProperty('role');
  });
});

describe('tenant lifecycle', () => {
  it('treats deleted as terminal', () => {
    for (const status of TENANT_STATUSES) {
      expect(canTransitionTenant('deleted', status), status).toBe(false);
    }
  });

  it('keeps accepting inbound while suspended, but blocks replies', () => {
    expect(TENANT_STATUS_EFFECTS.suspended.inboundAccepted).toBe(true);
    expect(TENANT_STATUS_EFFECTS.suspended.outboundAllowed).toBe(false);
  });

  it('leaves a past_due tenant fully operational', () => {
    expect(TENANT_STATUS_EFFECTS.past_due).toEqual({
      apiAccess: true,
      inboundAccepted: true,
      outboundAllowed: true,
    });
  });
});

describe('message status ordering', () => {
  it('only moves forward', () => {
    expect(isMessageStatusAdvance('sent', 'delivered')).toBe(true);
    expect(isMessageStatusAdvance('read', 'delivered')).toBe(false);
    expect(isMessageStatusAdvance('delivered', 'delivered')).toBe(false);
  });

  it('never resurrects a failed message', () => {
    expect(isMessageStatusAdvance('failed', 'sent')).toBe(false);
    expect(isMessageStatusAdvance('failed', 'read')).toBe(false);
  });
});

describe('send message input', () => {
  it('accepts a text send', () => {
    expect(SendMessageInputSchema.parse({ type: 'text', body: 'hello' }).type).toBe('text');
  });

  it('rejects a text send with an empty body', () => {
    expect(() => SendMessageInputSchema.parse({ type: 'text', body: '' })).toThrow();
  });

  it('requires a template name for a template send', () => {
    expect(() => SendMessageInputSchema.parse({ type: 'template', languageCode: 'en' })).toThrow();
  });
});

describe('E.164 phone numbers', () => {
  it('accepts an international number', () => {
    expect(PhoneE164Schema.parse('+966501234567')).toBe('+966501234567');
  });

  it('rejects local formatting, spaces and a leading zero', () => {
    expect(() => PhoneE164Schema.parse('0501234567')).toThrow();
    expect(() => PhoneE164Schema.parse('+966 50 123 4567')).toThrow();
    expect(() => PhoneE164Schema.parse('+0501234567')).toThrow();
  });
});

describe('tenant provisioning input', () => {
  const valid = { slug: 'acme', name: 'Acme Ltd' };

  it('accepts the minimum an operator has to supply', () => {
    expect(ProvisionTenantInputSchema.parse(valid)).toEqual(valid);
  });

  it('rejects a slug that would not survive being a DNS label', () => {
    for (const slug of ['-acme', 'acme-', 'Acme', 'ac me', 'ac', 'acme_ltd', 'acme.ltd']) {
      expect(() => ProvisionTenantInputSchema.parse({ ...valid, slug }), slug).toThrow();
    }
  });

  it('strips a caller-supplied hostname rather than honouring it', () => {
    // The platform subdomain is derived from the slug server-side. A client
    // that sends one must not be able to claim another tenant's host.
    const parsed = ProvisionTenantInputSchema.parse({
      ...valid,
      primaryHostname: 'globex.app.example.com',
    });

    expect(parsed).not.toHaveProperty('primaryHostname');
  });

  it('rejects a time zone the runtime cannot resolve', () => {
    expect(IanaTimezoneSchema.parse('Europe/London')).toBe('Europe/London');
    expect(() => IanaTimezoneSchema.parse('CET+1')).toThrow();
    expect(() => IanaTimezoneSchema.parse('Mars/Olympus_Mons')).toThrow();
  });
});

describe('the two tenant status vocabularies', () => {
  // Pinned rather than asserted equal: they genuinely differ today, and the
  // point of this test is that the difference cannot widen without someone
  // reading the comment on PROVISIONED_TENANT_STATUSES. TAR-36 reconciles them.
  it('agrees on every status they share', () => {
    const shared = PROVISIONED_TENANT_STATUSES.filter((status) =>
      (TENANT_STATUSES as readonly string[]).includes(status),
    );

    expect(shared).toEqual(['active', 'suspended', 'cancelled']);
  });

  it('records exactly the statuses each side has and the other does not', () => {
    const onlyProvisioning = PROVISIONED_TENANT_STATUSES.filter(
      (status) => !(TENANT_STATUSES as readonly string[]).includes(status),
    );
    const onlyCustomerFacing = TENANT_STATUSES.filter(
      (status) => !(PROVISIONED_TENANT_STATUSES as readonly string[]).includes(status),
    );

    expect(onlyProvisioning).toEqual(['pending']);
    expect(onlyCustomerFacing).toEqual(['trialing', 'past_due', 'deleted']);
  });
});

describe('whatsapp business account', () => {
  const waba = {
    id: '01890a5d-ac96-774b-bcce-b302099a8057',
    wabaId: '102290129340398',
    name: 'Acme Trading',
    verificationStatus: 'verified',
    createdAt: '2026-08-10T09:30:24Z',
    updatedAt: '2026-08-10T09:30:24Z',
  };

  // The one property this schema exists to guarantee. The encrypted access
  // token lives on this entity (TAR-52), so a handler that selected the row
  // wholesale and returned it is exactly the mistake to make — and the response
  // schema is the last place that can catch it.
  it('strips an access token that reached the response by accident', () => {
    const parsed = WhatsAppBusinessAccountResponseSchema.parse({
      ...waba,
      accessTokenEncrypted: 'v1:aes-256-gcm:leaked',
      accessToken: 'EAAG...',
    });

    expect(parsed).not.toHaveProperty('accessTokenEncrypted');
    expect(parsed).not.toHaveProperty('accessToken');
    expect(JSON.stringify(parsed)).not.toContain('EAAG');
  });

  it('keys a template to its WABA, not to the tenant', () => {
    expect(Object.keys(MessageTemplateResponseSchema.shape)).toContain('whatsappBusinessAccountId');
  });
});

describe('usage metrics', () => {
  it('classifies every metric as a counter or a gauge', () => {
    for (const metric of USAGE_METRICS) {
      expect(USAGE_METRIC_KINDS[metric], metric).toMatch(/^(counter|gauge)$/);
    }
  });

  it('treats seats as a gauge and conversations as a counter', () => {
    expect(USAGE_METRIC_KINDS.seats_active).toBe('gauge');
    expect(USAGE_METRIC_KINDS.conversations_opened).toBe('counter');
  });
});

import { describe, expect, it } from 'vitest';
import { PROVISIONED_TENANT_STATUSES, ProvisionTenantInputSchema } from './admin';
import {
  AUTH_POLICY,
  PasswordChangeInputSchema,
  PasswordSchema,
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME_SECURE,
  sessionCookieName,
} from './auth';
import { IanaTimezoneSchema, PhoneE164Schema } from './common';
import { API_ERROR_CODES, API_ERROR_STATUS, httpStatusForErrorCode } from './error-codes';
import { isMessageStatusAdvance, SendMessageInputSchema } from './messages';
import { permissionsForRole, ROLE_PERMISSIONS, roleHasPermission, TENANT_ROLES } from './rbac';
import { canTransitionTenant, TENANT_STATUSES, TENANT_STATUS_EFFECTS } from './tenant';
import { USAGE_METRIC_KINDS, USAGE_METRICS } from './usage';
import { ASSIGNABLE_USER_STATUSES, USER_STATUSES, UserUpdateInputSchema } from './users';
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

describe('auth policy (TAR-53)', () => {
  it('never lets the sliding idle window outlive the absolute cap', () => {
    // The whole point of the absolute cap is that no amount of activity extends
    // a session past it. An idle window at or above it would silently disable it.
    expect(AUTH_POLICY.sessionIdleMs).toBeLessThan(AUTH_POLICY.sessionAbsoluteMs);
  });

  it('throttles the expires_at write to far less than the idle window', () => {
    // Sliding on every request would put a row UPDATE on the hot path of every
    // API call. The throttle is only sound while it is small next to the window.
    expect(AUTH_POLICY.sessionSlideThrottleMs).toBeLessThan(AUTH_POLICY.sessionIdleMs / 10);
  });

  it('keeps a stale cached principal inside the bound TAR-39 stated', () => {
    expect(AUTH_POLICY.sessionCacheTtlMs).toBeLessThanOrEqual(60_000);
  });

  it('expires a reset link far sooner than an invite', () => {
    // Different threat models: the invite recipient may be on holiday, the
    // person resetting a password is at the keyboard now.
    expect(AUTH_POLICY.passwordResetTtlMs).toBeLessThan(AUTH_POLICY.inviteTtlMs);
  });

  it('agrees with the password schema on both bounds', () => {
    expect(PasswordSchema.safeParse('x'.repeat(AUTH_POLICY.passwordMinLength)).success).toBe(true);
    expect(PasswordSchema.safeParse('x'.repeat(AUTH_POLICY.passwordMinLength - 1)).success).toBe(
      false,
    );
    expect(PasswordSchema.safeParse('x'.repeat(AUTH_POLICY.passwordMaxLength + 1)).success).toBe(
      false,
    );
  });

  it('lets an IP spray at more accounts than it can lock a single one out with', () => {
    // The per-IP layer exists to catch spraying at addresses that have no user
    // row to count on, so it must not trip before the per-account layer does.
    expect(AUTH_POLICY.ipFailureThreshold).toBeGreaterThan(AUTH_POLICY.loginFailureThreshold);
  });
});

describe('session cookie (TAR-53)', () => {
  it('uses the __Host- prefix wherever it can be set', () => {
    expect(sessionCookieName(true)).toBe(SESSION_COOKIE_NAME_SECURE);
    expect(sessionCookieName(true).startsWith('__Host-')).toBe(true);
  });

  it('falls back to an unprefixed name only when the cookie cannot be Secure', () => {
    // Safari does not treat plain-HTTP localhost as a secure context, and a
    // __Host- cookie without Secure is rejected outright by every browser.
    expect(sessionCookieName(false).startsWith('__Host-')).toBe(false);
  });

  it('never carries a Domain attribute', () => {
    // A cookie scoped to the platform's parent domain would be sent to every
    // tenant subdomain under it — the exact cross-tenant leak white-label
    // hosting makes possible.
    expect(SESSION_COOKIE_ATTRIBUTES).not.toHaveProperty('domain');
    expect(SESSION_COOKIE_ATTRIBUTES.path).toBe('/');
    expect(SESSION_COOKIE_ATTRIBUTES.httpOnly).toBe(true);
    expect(SESSION_COOKIE_ATTRIBUTES.sameSite).toBe('lax');
  });
});

describe('password change (TAR-53)', () => {
  it('demands the current password from an already-authenticated caller', () => {
    // A session cookie proves the browser has a cookie, not that the person at
    // the keyboard owns the account.
    expect(() =>
      PasswordChangeInputSchema.parse({ newPassword: 'correct horse battery' }),
    ).toThrow();
  });
});

describe('user statuses (TAR-53)', () => {
  it('carries removed, because removing a user is a status change not a delete', () => {
    expect(USER_STATUSES).toContain('removed');
  });

  it('does not let an admin PATCH someone back into invited', () => {
    // That would produce a user who can never sign in and has no live invite.
    expect(ASSIGNABLE_USER_STATUSES).not.toContain('invited');
    expect(() => UserUpdateInputSchema.parse({ status: 'invited' })).toThrow();
    expect(UserUpdateInputSchema.parse({ status: 'suspended' }).status).toBe('suspended');
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

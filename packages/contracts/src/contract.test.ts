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
import { ApiErrorSchema } from './error';
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  httpStatusForErrorCode,
  WHATSAPP_SIGNUP_FAILURE_REASONS,
  whatsAppSignupFailureDetails,
  whatsAppSignupFailureReason,
} from './error-codes';
import { isMessageStatusAdvance, SendMessageInputSchema } from './messages';
import {
  isRoleWithin,
  permissionsForRole,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  roleHasPermission,
  TENANT_ROLES,
} from './rbac';
import {
  canTransitionTenant,
  EDGE_AUTH_HEADER,
  TENANT_HOST_HEADER,
  TENANT_STATUSES,
  TENANT_STATUS_EFFECTS,
} from './tenant';
import {
  canAgentTransition,
  TICKET_EVENT_CAUSES,
  TICKET_PRIORITIES,
  TICKET_STATUS_REQUIRES_CLOSE,
  TICKET_STATUSES,
  TicketEventSchema,
  TicketListQuerySchema,
  TicketUpdateInputSchema,
} from './tickets';
import { USAGE_METRIC_KINDS, USAGE_METRICS } from './usage';
import {
  AvailabilityUpdateInputSchema,
  TEAM_MEMBERSHIP_LIMITS,
  TeamCreateInputSchema,
  TeamResponseSchema,
  TeamUpdateInputSchema,
  USER_STATUSES,
  UserResponseSchema,
  UserUpdateInputSchema,
} from './users';
import {
  ConnectedWhatsAppBusinessAccountResponseSchema,
  ConnectWhatsAppBusinessAccountInputSchema,
  MESSAGE_TEMPLATE_SEND_BLOCKERS,
  MessageTemplateAdminListQuerySchema,
  MessageTemplateAdminResponseSchema,
  MessageTemplateListQuerySchema,
  MessageTemplateResponseSchema,
  WhatsAppBusinessAccountResponseSchema,
  WhatsAppEmbeddedSignupInputSchema,
} from './whatsapp';

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

describe('a failed embedded signup (TAR-161)', () => {
  const envelope = (details: ReturnType<typeof whatsAppSignupFailureDetails>) => ({
    error: {
      code: 'whatsapp_signup_failed',
      message: 'WhatsApp signup could not be completed.',
      details,
      requestId: '01890a5d-ac96-774b-bcce-b302099a8057',
    },
  });

  it('publishes exactly the four reasons the amendment rules', () => {
    expect([...WHATSAPP_SIGNUP_FAILURE_REASONS]).toEqual([
      'code_expired',
      'code_invalid',
      'insufficient_permissions',
      'waba_mismatch',
    ]);
  });

  it('does not answer 502, because Meta answered — it refused the grant', () => {
    // `upstream_unavailable` and `rate_limited` keep the cases that *are*
    // retryable as sent; this one needs the whole flow re-run.
    expect(httpStatusForErrorCode('whatsapp_signup_failed')).toBe(400);
  });

  it('carries every reason through the envelope TAR-38 already publishes', () => {
    // 0002 writes `details.reason`, and `ApiErrorSchema.details` is an array of
    // `{ path, message }`. The reason rides as one entry rather than widening
    // the envelope for one code, so this has to stay envelope-legal.
    for (const reason of WHATSAPP_SIGNUP_FAILURE_REASONS) {
      const parsed = ApiErrorSchema.parse(envelope(whatsAppSignupFailureDetails(reason)));

      expect(whatsAppSignupFailureReason(parsed), reason).toBe(reason);
    }
  });

  it('reads a reason it does not recognise as none, rather than throwing', () => {
    // A console running yesterday's bundle against an API that has published a
    // fifth reason falls back to the generic message, exactly as it does for an
    // unknown `code`.
    const parsed = ApiErrorSchema.parse(
      envelope([{ path: 'reason', message: 'shipped_after_this_build' }]),
    );

    expect(whatsAppSignupFailureReason(parsed)).toBeNull();
  });

  it('reads no reason from an error that carries none', () => {
    expect(whatsAppSignupFailureReason(ApiErrorSchema.parse(envelope([])))).toBeNull();
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

/**
 * TAR-244. Membership is the one array in this contract whose fan-out is not
 * naturally small: every id in it costs a session revocation and a cache purge
 * for that person, so an unbounded array was an unbounded amount of work a
 * `team:write` caller could ask of a shared connection pool in one request.
 */
describe('team membership bounds', () => {
  const ids = (count: number): string[] =>
    Array.from(
      { length: count },
      (_, index) => `0192f0ff-0000-7000-8000-${(index + 1).toString(16).padStart(12, '0')}`,
    );

  const atTheCeiling = ids(TEAM_MEMBERSHIP_LIMITS.membersPerTeam);
  const overIt = ids(TEAM_MEMBERSHIP_LIMITS.membersPerTeam + 1);

  it('accepts a team at the ceiling and refuses one past it', () => {
    expect(
      TeamCreateInputSchema.parse({ name: 'Billing', memberUserIds: atTheCeiling }).memberUserIds,
    ).toHaveLength(TEAM_MEMBERSHIP_LIMITS.membersPerTeam);
    expect(() => TeamCreateInputSchema.parse({ name: 'Billing', memberUserIds: overIt })).toThrow();
  });

  it('keeps the ceiling through `.partial()` on the update', () => {
    // A replace is the operation with the *larger* fan-out of the two — it
    // revokes for everybody added and everybody removed — so an update that
    // inherited optionality without the bound would be the hole.
    expect(() => TeamUpdateInputSchema.parse({ memberUserIds: overIt })).toThrow();
    expect(TeamUpdateInputSchema.parse({ memberUserIds: atTheCeiling })).toBeDefined();
  });

  it('publishes a maximum response size rather than implying one', () => {
    expect(() =>
      TeamResponseSchema.parse({
        id: '0192f0ff-0000-7000-8000-00000000b001',
        name: 'Billing',
        description: null,
        memberUserIds: overIt,
        createdAt: '2026-08-10T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('bounds the other direction too, on `PATCH /users/{id}`', () => {
    // Otherwise the cap on a team is one loop away from meaningless: the same
    // membership rows can be written a person at a time from this side.
    expect(() =>
      UserUpdateInputSchema.parse({ teamIds: ids(TEAM_MEMBERSHIP_LIMITS.teamsPerUser + 1) }),
    ).toThrow();
    expect(
      UserUpdateInputSchema.parse({ teamIds: ids(TEAM_MEMBERSHIP_LIMITS.teamsPerUser) }).teamIds,
    ).toHaveLength(TEAM_MEMBERSHIP_LIMITS.teamsPerUser);
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

  it('tells the browser to drop the cookie exactly when the server would', () => {
    // maxAge is seconds, sessionAbsoluteMs is milliseconds. Two hand-maintained
    // numbers is how a cookie outlives the session it names.
    expect(SESSION_COOKIE_ATTRIBUTES.maxAge * 1000).toBe(AUTH_POLICY.sessionAbsoluteMs);
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

describe('lockout visibility (TAR-53)', () => {
  const baseUser = {
    id: '018f3a5c-0000-7000-8000-000000000001',
    email: 'agent@acme.test',
    displayName: 'Agent',
    avatarUrl: null,
    role: 'agent',
    status: 'active',
    availability: 'available',
    teamIds: [],
    occupiesSeat: true,
    lastSeenAt: null,
    createdAt: '2026-08-10T00:00:00.000Z',
  };

  it('lets the serializer withhold lockout state as a whole', () => {
    // `user:read` is an agent permission, so a flat `failedLoginAttempts` would
    // give every agent a live readout of how close a colleague is to lockout.
    expect(UserResponseSchema.parse({ ...baseUser, security: null }).security).toBeNull();
  });

  it('keeps the two fields together, so neither can be exposed on its own', () => {
    expect(() =>
      UserResponseSchema.parse({ ...baseUser, security: { lockedUntil: null } }),
    ).toThrow();

    const visible = UserResponseSchema.parse({
      ...baseUser,
      security: { lockedUntil: null, failedLoginAttempts: 3 },
    });

    expect(visible.security?.failedLoginAttempts).toBe(3);
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

/**
 * The pair that tells the API which tenant a request is for (TAR-64, TAR-148).
 *
 * These are pinned to their literal spellings rather than merely imported,
 * because the failure they guard against is silent and total: the web tier and
 * `HostTenantGuard` read the same two constants, so a rename that reaches only
 * one deployed service leaves every tenant route answering `tenant_not_found`
 * while both sides still report the feature enabled. A wire format is a value,
 * not an implementation detail, and changing one of these means changing a
 * deployed contract — this is the test that says so out loud.
 */
describe('tenant routing headers (TAR-64)', () => {
  it('names the tenant host on a private header, not a standard forwarding one', () => {
    // Deliberately not `x-forwarded-host`: the web tier reaches the API over the
    // public internet, through proxies that populate `x-forwarded-*` as a matter
    // of course and are entitled to rewrite it.
    expect(TENANT_HOST_HEADER).toBe('x-edge-host');
    expect(TENANT_HOST_HEADER).not.toBe('x-forwarded-host');
  });

  it('carries the proof on a header of its own', () => {
    expect(EDGE_AUTH_HEADER).toBe('x-edge-auth');
  });

  it('keeps the two distinct, since one authenticates the other', () => {
    expect(TENANT_HOST_HEADER).not.toBe(EDGE_AUTH_HEADER);
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

/**
 * The supervisor's flagged queue (TAR-274) reads this schema from a URL, so every
 * value reaches it as a string.
 */
describe('the ticket list query', () => {
  it('narrows the deferred queue to one reason', () => {
    const parsed = TicketListQuerySchema.parse({
      scope: 'unassigned',
      routingState: 'deferred',
      deferredReason: 'no_candidate_pool',
    });

    expect(parsed.deferredReason).toBe('no_candidate_pool');
  });

  it('refuses a reason outside the published vocabulary', () => {
    expect(TicketListQuerySchema.safeParse({ deferredReason: 'everything_is_fine' }).success).toBe(
      false,
    );
  });

  it('leaves the reason absent rather than defaulting it', () => {
    expect(TicketListQuerySchema.parse({}).deferredReason).toBeUndefined();
  });

  /**
   * `breachedOnly` is the only boolean the contract puts on a query schema. It was
   * `z.boolean()`, which no query string can ever satisfy — and `z.coerce.boolean()`
   * would read `'false'` as `true`, silently widening the filter.
   */
  it('reads breachedOnly from the string a query carries', () => {
    expect(TicketListQuerySchema.parse({ breachedOnly: 'true' }).breachedOnly).toBe(true);
    expect(TicketListQuerySchema.parse({ breachedOnly: 'false' }).breachedOnly).toBe(false);
  });

  it('defaults breachedOnly to false when the parameter is absent', () => {
    expect(TicketListQuerySchema.parse({}).breachedOnly).toBe(false);
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

  describe('a template header', () => {
    const send = { type: 'template', templateName: 'order_update', languageCode: 'en_US' };

    it('carries the media a media-header template needs', () => {
      // Without a slot for it, an approved IMAGE-header template passes the
      // picker and the arity check and still fails at Meta.
      const parsed = SendMessageInputSchema.parse({
        ...send,
        header: { format: 'image', mediaId: '90444444-4444-7444-8444-444444444401' },
      });

      expect(parsed).toMatchObject({ header: { format: 'image' } });
    });

    it('carries the variables a text-header template needs, apart from the body ones', () => {
      const parsed = SendMessageInputSchema.parse({
        ...send,
        variables: ['A', 'B'],
        header: { format: 'text', variables: ['C'] },
      });

      expect(parsed).toMatchObject({ variables: ['A', 'B'], header: { variables: ['C'] } });
    });

    it('stays optional, because most templates have no header', () => {
      expect(SendMessageInputSchema.parse(send)).not.toHaveProperty('header');
    });

    it.each([
      ['a media header with no media', { format: 'image' }],
      ['a text header with no variables', { format: 'text', variables: [] }],
      ['a media id that is not an id', { format: 'image', mediaId: 'nope' }],
      ['a format outside the published set', { format: 'carousel', mediaId: 'x' }],
      ['coordinates outside the globe', { format: 'location', latitude: 200, longitude: 0 }],
    ])('rejects %s', (_case, header) => {
      expect(() => SendMessageInputSchema.parse({ ...send, header })).toThrow();
    });
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

describe('connecting a whatsapp business account', () => {
  const valid = {
    wabaId: '102290129340398',
    accessToken: 'EAAG-a-real-looking-meta-access-token',
    phoneNumbers: [{ phoneNumberId: '15550001111', displayPhoneNumber: '+15550001111' }],
  };

  it('accepts the minimum an operator has to supply', () => {
    expect(ConnectWhatsAppBusinessAccountInputSchema.parse(valid)).toMatchObject({
      wabaId: valid.wabaId,
    });
  });

  it('requires at least one number, because a WABA without one cannot send or receive', () => {
    expect(() =>
      ConnectWhatsAppBusinessAccountInputSchema.parse({ ...valid, phoneNumbers: [] }),
    ).toThrow();
  });

  it('rejects the same phone number twice in one request', () => {
    expect(() =>
      ConnectWhatsAppBusinessAccountInputSchema.parse({
        ...valid,
        phoneNumbers: [...valid.phoneNumbers, ...valid.phoneNumbers],
      }),
    ).toThrow();
  });

  it('rejects an id that is not a Meta Graph id', () => {
    // Meta's ids exceed Number.MAX_SAFE_INTEGER, so they stay strings — but
    // they are still digits, and an arbitrary string here becomes an index key.
    for (const wabaId of ['not-an-id', '10229 0129', '', '1'.repeat(33)]) {
      expect(
        () => ConnectWhatsAppBusinessAccountInputSchema.parse({ ...valid, wabaId }),
        wabaId,
      ).toThrow();
    }
  });

  it('rejects a display number that is not E.164', () => {
    expect(() =>
      ConnectWhatsAppBusinessAccountInputSchema.parse({
        ...valid,
        phoneNumbers: [{ phoneNumberId: '15550001111', displayPhoneNumber: '555-0001' }],
      }),
    ).toThrow();
  });

  it('strips a caller-supplied tenant id rather than honouring it', () => {
    // The tenant comes from the path and the platform-admin guard. A body field
    // that could redirect the connection to another tenant must not survive.
    const parsed = ConnectWhatsAppBusinessAccountInputSchema.parse({
      ...valid,
      tenantId: '50444444-4444-7444-8444-4444444444c1',
    });

    expect(parsed).not.toHaveProperty('tenantId');
  });

  it('never publishes a token on the way back out', () => {
    const parsed = ConnectedWhatsAppBusinessAccountResponseSchema.parse({
      id: '01890a5d-ac96-774b-bcce-b302099a8057',
      wabaId: valid.wabaId,
      name: null,
      verificationStatus: 'pending',
      createdAt: '2026-08-10T09:30:24Z',
      updatedAt: '2026-08-10T09:30:24Z',
      accessTokenEncrypted: 'v1.leaked',
      accounts: [],
    });

    expect(parsed).not.toHaveProperty('accessTokenEncrypted');
  });

  it('still requires the pasted token, because the operator path is unchanged', () => {
    // TAR-161 adds a second, tenant-facing input. It does not narrow this one:
    // an operator doing manual onboarding holds a token and no code.
    expect(() =>
      ConnectWhatsAppBusinessAccountInputSchema.parse({
        wabaId: valid.wabaId,
        phoneNumbers: valid.phoneNumbers,
      }),
    ).toThrow();
    expect(Object.keys(ConnectWhatsAppBusinessAccountInputSchema.shape)).toContain('accessToken');
  });
});

describe('connecting a whatsapp business account from the console (TAR-161)', () => {
  const valid = { code: 'AQD-a-real-looking-exchangeable-code', wabaId: '102290129340398' };

  it('accepts what embedded signup hands the browser', () => {
    expect(WhatsAppEmbeddedSignupInputSchema.parse(valid)).toEqual(valid);
  });

  it('takes the phone number id as an optional hint', () => {
    // The numbers that get attached are read from Meta on the new token: the
    // browser does not have `displayPhoneNumber` or `verifiedName`, which the
    // connection requires.
    expect(
      WhatsAppEmbeddedSignupInputSchema.parse({ ...valid, phoneNumberId: '15550001111' }),
    ).toMatchObject({ phoneNumberId: '15550001111' });
    expect(WhatsAppEmbeddedSignupInputSchema.parse(valid)).not.toHaveProperty('phoneNumberId');
  });

  // The property this schema exists to guarantee. The browser never holds a
  // WABA token — that is the whole reason Embedded Signup returns a code — so a
  // token arriving on this route is a mistake, and honouring one would put "a
  // pasted credential is acceptable here" on a tenant-facing route.
  it('has no token field, and drops one that arrives anyway', () => {
    expect(Object.keys(WhatsAppEmbeddedSignupInputSchema.shape)).not.toContain('accessToken');

    const parsed = WhatsAppEmbeddedSignupInputSchema.parse({
      ...valid,
      accessToken: 'EAAG-a-real-looking-meta-access-token',
    });

    expect(parsed).not.toHaveProperty('accessToken');
    expect(JSON.stringify(parsed)).not.toContain('EAAG');
  });

  it('strips a caller-supplied tenant id rather than honouring it', () => {
    // The tenant comes from the host and the session, never from the body.
    const parsed = WhatsAppEmbeddedSignupInputSchema.parse({
      ...valid,
      tenantId: '50444444-4444-7444-8444-4444444444c1',
    });

    expect(parsed).not.toHaveProperty('tenantId');
  });

  it('requires a code, which is the only credential in the request', () => {
    for (const code of [undefined, '', 'x'.repeat(1025)]) {
      expect(
        () => WhatsAppEmbeddedSignupInputSchema.parse({ ...valid, code }),
        String(code),
      ).toThrow();
    }
  });

  it('rejects a waba id that is not a Meta Graph id', () => {
    for (const wabaId of ['not-an-id', '10229 0129', '', '1'.repeat(33)]) {
      expect(() => WhatsAppEmbeddedSignupInputSchema.parse({ ...valid, wabaId }), wabaId).toThrow();
    }
  });
});

describe('the message template list', () => {
  const WHATSAPP_ACCOUNT_ID = '70444444-4444-7444-8444-444444444401';
  const WABA_ID = '60444444-4444-7444-8444-444444444401';

  it('paginates by cursor with a documented default and cap', () => {
    expect(MessageTemplateListQuerySchema.parse({})).toMatchObject({ limit: 25 });
    expect(() => MessageTemplateListQuerySchema.parse({ limit: 1000 })).toThrow();
  });

  it('offers no way to ask for an unapproved template', () => {
    // Meta refuses a send on anything but an approved template, so a `status`
    // parameter would only make a failed send reachable from the picker.
    const parsed = MessageTemplateListQuerySchema.parse({ status: 'rejected' });

    expect(parsed).not.toHaveProperty('status');
  });

  it('filters by the phone number the composer actually holds', () => {
    // `ConversationResponse` publishes `whatsappAccountId` and nothing maps one
    // to a WABA, so a WABA-only filter would leave the composer listing
    // unfiltered — offering templates that cannot be sent on that number.
    expect(
      MessageTemplateListQuerySchema.parse({ whatsappAccountId: WHATSAPP_ACCOUNT_ID }),
    ).toMatchObject({ whatsappAccountId: WHATSAPP_ACCOUNT_ID });
  });

  it('refuses a number and a business account at once, which name two scopes', () => {
    expect(() =>
      MessageTemplateListQuerySchema.parse({
        whatsappAccountId: WHATSAPP_ACCOUNT_ID,
        whatsappBusinessAccountId: WABA_ID,
      }),
    ).toThrow();
  });
});

describe('a listed message template', () => {
  const template = {
    id: '80444444-4444-7444-8444-444444444401',
    whatsappBusinessAccountId: '60444444-4444-7444-8444-444444444401',
    name: 'order_update',
    language: 'en_US',
    category: 'UTILITY',
    status: 'approved',
    components: [{ type: 'BODY', text: 'Order {{1}}' }],
    bodyText: 'Order {{1}}',
    parameterCount: 1,
    headerFormat: null,
    headerParameterCount: 0,
    requiresButtonParameters: false,
    providerTemplateId: '1001',
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:00:00.000Z',
  };

  it('publishes the arity a send has to match, alongside the raw tree', () => {
    // `SendTemplateInput.variables` is positional: without this every consumer
    // parses Meta's component tree itself, and the send path cannot check the
    // length before calling Meta.
    expect(MessageTemplateResponseSchema.parse(template)).toMatchObject({
      bodyText: 'Order {{1}}',
      parameterCount: 1,
      headerFormat: null,
    });
  });

  it('refuses a header format outside the published set', () => {
    expect(() =>
      MessageTemplateResponseSchema.parse({ ...template, headerFormat: 'carousel' }),
    ).toThrow();
  });

  describe('on the administration surface', () => {
    const administered = { ...template, sendable: true, sendBlockers: [] };

    it('carries every field the composer’s shape carries, plus why a row is blocked', () => {
      // Extended rather than restated, so a template cannot describe itself
      // differently depending on which list it was read through.
      expect(MessageTemplateAdminResponseSchema.parse(administered)).toMatchObject({
        bodyText: 'Order {{1}}',
        parameterCount: 1,
        sendable: true,
        sendBlockers: [],
      });
    });

    it('names both reasons a template can be missing from the picker', () => {
      // The two exclusions amendment 1 accepts on the promise that this surface
      // makes them visible. A blocker vocabulary short of either would leave one
      // of them unexplainable.
      expect(MESSAGE_TEMPLATE_SEND_BLOCKERS).toEqual([
        'meta_not_approved',
        'button_parameters_required',
      ]);
    });

    it('refuses a response claiming a blocked template is sendable', () => {
      // The one direction that matters: "nothing is wrong with this template"
      // about a template an agent cannot find is worse than no answer.
      expect(() =>
        MessageTemplateAdminResponseSchema.parse({
          ...administered,
          sendBlockers: ['meta_not_approved'],
        }),
      ).toThrow();
    });

    it('refuses a response claiming a sendable template is blocked', () => {
      expect(() =>
        MessageTemplateAdminResponseSchema.parse({ ...administered, sendable: false }),
      ).toThrow();
    });
  });
});

describe('listing every message template for administration', () => {
  const WABA_ID = '60444444-4444-7444-8444-444444444401';

  it('paginates by cursor with a documented default and cap', () => {
    expect(MessageTemplateAdminListQuerySchema.parse({})).toMatchObject({ limit: 25 });
    expect(() => MessageTemplateAdminListQuerySchema.parse({ limit: 1000 })).toThrow();
  });

  it('accepts a status filter, which the composer’s list refuses', () => {
    // Refused there because it would make a failed send reachable from a picker;
    // accepted here because showing unapproved templates is the point. It
    // narrows within what the caller may already see, never widens it.
    expect(MessageTemplateAdminListQuerySchema.parse({ status: 'rejected' })).toMatchObject({
      status: 'rejected',
    });
  });

  it('refuses a status outside the published set', () => {
    expect(() => MessageTemplateAdminListQuerySchema.parse({ status: 'archived' })).toThrow();
  });

  it('filters by business account, which is what an administrator holds', () => {
    // Templates are approved per WABA and shared by every number behind it, so a
    // number filter would be a longer way of naming the same set.
    expect(
      MessageTemplateAdminListQuerySchema.parse({ whatsappBusinessAccountId: WABA_ID }),
    ).toMatchObject({ whatsappBusinessAccountId: WABA_ID });
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

describe('the ticket transition table', () => {
  it('is terminal-for-active on resolved and closed', () => {
    // The invariant `tickets_one_active_per_contact` depends on: nothing an
    // agent can send re-activates a finished ticket, so the partial unique
    // index can never be the thing that refuses a PATCH.
    for (const status of TICKET_STATUSES) {
      expect(canAgentTransition('closed', status), status).toBe(false);
    }

    expect(canAgentTransition('resolved', 'open')).toBe(false);
    expect(canAgentTransition('resolved', 'pending')).toBe(false);
    expect(canAgentTransition('resolved', 'closed')).toBe(true);
  });

  it('lets an active ticket be closed without passing through resolved', () => {
    // Closing spam or a wrong number is not a resolution, and forcing the
    // two-step would put a fake `resolved_at` on every one of them.
    expect(canAgentTransition('open', 'closed')).toBe(true);
    expect(canAgentTransition('pending', 'closed')).toBe(true);
  });

  it('never lists a status as a transition to itself', () => {
    // Setting the value a ticket already has is a no-op the endpoint accepts,
    // not a move it validates — so it must never reach this table.
    for (const status of TICKET_STATUSES) {
      expect(canAgentTransition(status, status), status).toBe(false);
    }
  });

  it('asks for ticket:close on exactly the two terminal statuses', () => {
    expect(TICKET_STATUS_REQUIRES_CLOSE).toEqual({
      open: false,
      pending: false,
      resolved: true,
      closed: true,
    });
  });

  it('declares urgent last, which is what makes priority DESC urgent-first', () => {
    // Postgres orders an enum by declaration order and the queue is
    // `ORDER BY priority DESC`. Reordering this array inverts the queue.
    expect(TICKET_PRIORITIES.at(-1)).toBe('urgent');
    expect(TICKET_PRIORITIES.at(0)).toBe('low');
  });
});

describe('the ticket update input', () => {
  it('refuses a body with no field set', () => {
    // `{}` is a client bug with no honest answer; accepting it would report
    // success for a request that asked for nothing.
    expect(TicketUpdateInputSchema.safeParse({}).success).toBe(false);
  });

  it('accepts any one field on its own', () => {
    expect(TicketUpdateInputSchema.safeParse({ status: 'resolved' }).success).toBe(true);
    expect(TicketUpdateInputSchema.safeParse({ priority: 'urgent' }).success).toBe(true);
    expect(TicketUpdateInputSchema.safeParse({ subject: 'Refund' }).success).toBe(true);
  });
});

describe('the ticket list query', () => {
  it('reads breachedOnly out of a query string, both ways round', () => {
    // It is parsed from `?breachedOnly=…`, so the value arrives as characters.
    // `z.boolean()` refused every one of them, which made the supervisor's
    // breached view a guaranteed 400.
    expect(TicketListQuerySchema.parse({ breachedOnly: 'true' }).breachedOnly).toBe(true);
    expect(TicketListQuerySchema.parse({ breachedOnly: 'false' }).breachedOnly).toBe(false);
  });

  it('does not read a bare "false" as truthy', () => {
    // The trap in `z.coerce.boolean()`, which is `Boolean(value)` — every
    // non-empty string, including "false", becomes `true`. Asserted rather than
    // trusted, because the two spellings look interchangeable at a glance.
    expect(TicketListQuerySchema.parse({ breachedOnly: 'false' }).breachedOnly).toBe(false);
    expect(TicketListQuerySchema.parse({ breachedOnly: '0' }).breachedOnly).toBe(false);
  });

  it('refuses a value that is not a boolean token', () => {
    expect(TicketListQuerySchema.safeParse({ breachedOnly: 'perhaps' }).success).toBe(false);
  });

  it('defaults to the active queue for everybody’s own work', () => {
    const query = TicketListQuerySchema.parse({});

    expect(query).toMatchObject({ scope: 'assigned', breachedOnly: false, limit: 25 });
    // No status filter: the service reads that as "the active statuses", which
    // is what makes a resolved ticket leave the queue with no client change.
    expect(query.status).toBeUndefined();
  });
});

describe('ticket event causes', () => {
  it('publishes the token that tells an agent reopen from a customer reply', () => {
    expect(TICKET_EVENT_CAUSES).toContain('agent');
    expect(TICKET_EVENT_CAUSES).toContain('inbound_message');
  });

  it('carries the cause on a published event, nullable for the types that predate it', () => {
    const event = {
      id: '25444444-4444-7444-8444-4444444444e1',
      ticketId: '25444444-4444-7444-8444-4444444444f1',
      type: 'status_changed',
      actorUserId: null,
      fromValue: 'pending',
      toValue: 'open',
      reason: null,
      cause: 'inbound_message',
      createdAt: '2026-08-13T09:00:00.000Z',
    };

    expect(TicketEventSchema.parse(event)).toMatchObject({ cause: 'inbound_message' });
    expect(TicketEventSchema.parse({ ...event, cause: null }).cause).toBeNull();
    expect(() => TicketEventSchema.parse({ ...event, cause: 'telepathy' })).toThrow();
  });
});

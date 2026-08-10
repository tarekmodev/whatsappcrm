import { describe, expect, it } from 'vitest';
import { PROVISIONED_TENANT_STATUSES, ProvisionTenantInputSchema } from './admin';
import { IanaTimezoneSchema, PhoneE164Schema } from './common';
import { API_ERROR_CODES, API_ERROR_STATUS, httpStatusForErrorCode } from './error-codes';
import { isMessageStatusAdvance, SendMessageInputSchema } from './messages';
import { permissionsForRole, ROLE_PERMISSIONS, roleHasPermission, TENANT_ROLES } from './rbac';
import { canTransitionTenant, TENANT_STATUSES, TENANT_STATUS_EFFECTS } from './tenant';
import { USAGE_METRIC_KINDS, USAGE_METRICS } from './usage';
import {
  ConnectedWhatsAppBusinessAccountResponseSchema,
  ConnectWhatsAppBusinessAccountInputSchema,
  MessageTemplateListQuerySchema,
  MessageTemplateResponseSchema,
  WhatsAppBusinessAccountResponseSchema,
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

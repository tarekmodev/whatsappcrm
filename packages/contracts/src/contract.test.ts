import { describe, expect, it } from 'vitest';
import { PhoneE164Schema } from './common';
import { API_ERROR_CODES, API_ERROR_STATUS, httpStatusForErrorCode } from './error-codes';
import { isMessageStatusAdvance, SendMessageInputSchema } from './messages';
import { permissionsForRole, ROLE_PERMISSIONS, roleHasPermission, TENANT_ROLES } from './rbac';
import { canTransitionTenant, TENANT_STATUSES, TENANT_STATUS_EFFECTS } from './tenant';
import { USAGE_METRIC_KINDS, USAGE_METRICS } from './usage';

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

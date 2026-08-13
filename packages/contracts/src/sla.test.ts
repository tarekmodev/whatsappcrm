import { describe, expect, it } from 'vitest';
import {
  SLA_DEFAULTS,
  SlaAlertListQuerySchema,
  SlaAlertResponseSchema,
  SlaPolicyUpdateInputSchema,
  isSlaBreached,
} from './sla';
import type { TicketSla } from './tickets';

/**
 * The SLA surface ADR 0006 publishes, pinned where getting it wrong is silent.
 */

const IDS = {
  ticket: '0192f00a-0000-7000-8000-000000000a01',
  timer: '0192f00f-0000-7000-8000-000000000f01',
  alert: '0192f00e-0000-7000-8000-000000000e01',
};

describe('isSlaBreached', () => {
  const base: TicketSla = {
    policyId: null,
    firstResponseState: 'running',
    firstResponseDueAt: '2026-08-09T15:05:00.000Z',
    resolutionState: 'not_applicable',
    resolutionDueAt: null,
  };

  it('is true when either timer has breached', () => {
    expect(isSlaBreached({ ...base, firstResponseState: 'breached' })).toBe(true);
    expect(isSlaBreached({ ...base, resolutionState: 'breached' })).toBe(true);
  });

  it('is false for every other combination', () => {
    for (const state of ['not_applicable', 'running', 'paused', 'met'] as const) {
      expect(isSlaBreached({ ...base, firstResponseState: state })).toBe(false);
    }
  });
});

describe('SlaAlertListQuerySchema', () => {
  it('defaults to what still needs attention', () => {
    expect(SlaAlertListQuerySchema.parse({}).unacknowledgedOnly).toBe(true);
  });

  it('lets a caller ask for the acknowledged ones too, from a query string', () => {
    // `z.coerce.boolean()` would read this as `true` — it is `Boolean('false')`
    // — and answer the opposite question. `z.stringbool()` is why it does not.
    expect(SlaAlertListQuerySchema.parse({ unacknowledgedOnly: 'false' }).unacknowledgedOnly).toBe(
      false,
    );
  });

  it('refuses a value that is neither, rather than guessing', () => {
    expect(SlaAlertListQuerySchema.safeParse({ unacknowledgedOnly: 'maybe' }).success).toBe(false);
  });
});

describe('SlaAlertResponseSchema', () => {
  const alert = {
    id: IDS.alert,
    ticketId: IDS.ticket,
    ticketNumber: 1042,
    slaTimerId: IDS.timer,
    kind: 'first_response',
    dueAt: '2026-08-09T15:05:00.000Z',
    assignedUserId: null,
    assignedTeamId: null,
    acknowledgedAt: null,
    createdAt: '2026-08-09T15:05:30.000Z',
  };

  it('accepts an alert about a ticket nobody was holding', () => {
    // The fallback branch of ADR 0006 decision 4 — an unassigned ticket still
    // raises an alert, to every supervisor in the tenant.
    expect(SlaAlertResponseSchema.safeParse(alert).success).toBe(true);
  });

  it('refuses to publish who it was addressed to', () => {
    // The narrowing is `recipient_user_id = me`, server-side. A response that
    // carried the column would invite a client to filter on it instead.
    expect(SlaAlertResponseSchema.parse(alert)).not.toHaveProperty('recipientUserId');
  });
});

describe('SlaPolicyUpdateInputSchema', () => {
  it('refuses an empty patch rather than treating it as a no-op', () => {
    expect(SlaPolicyUpdateInputSchema.safeParse({}).success).toBe(false);
  });

  it('refuses a window outside 1–43,200 minutes', () => {
    expect(SlaPolicyUpdateInputSchema.safeParse({ firstResponseMinutes: 0 }).success).toBe(false);
    expect(SlaPolicyUpdateInputSchema.safeParse({ firstResponseMinutes: 43_201 }).success).toBe(
      false,
    );
  });

  it('accepts null, which is how a tenant turns one target off', () => {
    expect(SlaPolicyUpdateInputSchema.safeParse({ resolutionMinutes: null }).success).toBe(true);
  });
});

describe('SLA_DEFAULTS', () => {
  it('is TAR-26’s stated assumption: a first response within the hour', () => {
    expect(SLA_DEFAULTS.firstResponseMinutes).toBe(60);
    // The seeded policy ships no resolution target; only the first-response
    // timer exists at v1 (ADR 0006 Non-Goals).
    expect(SLA_DEFAULTS.resolutionMinutes).toBeNull();
  });
});

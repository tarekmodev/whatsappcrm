import { toNotificationResponse, type NotificationRow } from './notification.mapper';

/**
 * The mapper's two jobs, both of which fail silently if they are wrong: reading
 * an untyped `data` blob without trusting it, and refusing a row this surface
 * does not publish rather than answering with a `type` no client has a branch
 * for.
 */

const ROW: NotificationRow = {
  id: '32000000-0000-7000-8000-0000000000a1',
  type: 'sla_breach',
  ticketId: '32000000-0000-7000-8000-0000000000a2',
  slaTimerId: '32000000-0000-7000-8000-0000000000a3',
  dueAt: new Date('2026-08-22T08:00:00.000Z'),
  data: null,
  acknowledgedAt: null,
  createdAt: new Date('2026-08-22T09:00:00.000Z'),
  ticket: { number: 412 },
};

describe('toNotificationResponse', () => {
  it('publishes the SLA columns and nulls the workflow ones', () => {
    expect(toNotificationResponse(ROW)).toEqual({
      id: ROW.id,
      type: 'sla_breach',
      ticketId: ROW.ticketId,
      ticketNumber: 412,
      slaTimerId: ROW.slaTimerId,
      dueAt: '2026-08-22T08:00:00.000Z',
      message: null,
      workflowId: null,
      workflowRunId: null,
      acknowledgedAt: null,
      createdAt: '2026-08-22T09:00:00.000Z',
    });
  });

  it('nulls a `data` blob of the wrong shape rather than failing the page', () => {
    const mapped = toNotificationResponse({
      ...ROW,
      type: 'workflow_notify',
      slaTimerId: null,
      dueAt: null,
      data: ['not', 'an', 'object'],
    });

    expect(mapped).toMatchObject({ message: null, workflowId: null, workflowRunId: null });
  });

  it('nulls a field of `data` that is not a string', () => {
    const mapped = toNotificationResponse({
      ...ROW,
      type: 'workflow_broken',
      slaTimerId: null,
      dueAt: null,
      data: { workflowId: 42, workflowRunId: '32000000-0000-7000-8000-0000000000a4' },
    });

    expect(mapped).toMatchObject({
      workflowId: null,
      workflowRunId: '32000000-0000-7000-8000-0000000000a4',
    });
  });

  it('refuses an `escalation` row, which this surface does not publish', () => {
    expect(() =>
      // Only reachable through a query that forgot the type filter — which is
      // exactly the caller this throw exists to name.
      toNotificationResponse({ ...ROW, type: 'escalation', slaTimerId: null, dueAt: null }),
    ).toThrow(/unpublished type escalation/);
  });
});

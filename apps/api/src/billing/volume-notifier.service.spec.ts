import type { ConfigService } from '@nestjs/config';
import type { OutboundEmail, VolumePolicy } from '@whatsappcrm/contracts';
import type { ConversationVolumeChangedEvent } from '../events/domain-events';
import type { MailerPort } from '../identity/mailer/mailer.port';
import type { SystemPrisma } from '../prisma/prisma.tokens';
import { VolumeNotifierService } from './volume-notifier.service';

const TENANT = '0192f0ff-0000-7000-8000-0000000000a1';
const PERIOD_START = new Date('2026-08-01T00:00:00.000Z');

function notifierWith(options: {
  warnAt?: number;
  policy?: VolumePolicy;
  admins?: { email: string }[];
}) {
  const sent: OutboundEmail[] = [];
  const findMany = jest.fn().mockResolvedValue(options.admins ?? [{ email: 'admin@acme.example' }]);

  const notifier = new VolumeNotifierService(
    {
      getOrThrow: (key: string) =>
        key === 'BILLING_VOLUME_WARN_AT' ? (options.warnAt ?? 0.8) : (options.policy ?? 'warn'),
    } as unknown as ConfigService,
    {
      send: (message: OutboundEmail) => {
        sent.push(message);
        return Promise.resolve();
      },
    } satisfies MailerPort,
    { user: { findMany } } as unknown as SystemPrisma,
  );

  return { notifier, sent, findMany };
}

function crossing(opened: number, cap = 1_000): ConversationVolumeChangedEvent {
  return { tenantId: TENANT, opened, cap, periodStart: PERIOD_START };
}

/**
 * Once per period **by construction**, which is the property worth testing: the
 * event carries the count after an increment of one, so a crossing is
 * `opened - 1 < threshold <= opened` and is therefore true for exactly one event
 * in the period.
 */
describe('VolumeNotifierService', () => {
  it('warns on the conversation that crosses the threshold, and only that one', async () => {
    const { notifier, sent } = notifierWith({ warnAt: 0.8 });

    await notifier.onVolumeChanged(crossing(799));
    expect(sent).toHaveLength(0);

    await notifier.onVolumeChanged(crossing(800));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.template).toBe('volume_warning');

    await notifier.onVolumeChanged(crossing(801));
    expect(sent).toHaveLength(1);
  });

  it('sends the limit notice on the conversation that reaches the cap', async () => {
    const { notifier, sent } = notifierWith({});

    await notifier.onVolumeChanged(crossing(999));
    await notifier.onVolumeChanged(crossing(1_000));
    await notifier.onVolumeChanged(crossing(1_001));

    expect(sent.map((message) => message.template)).toEqual(['volume_limit_reached']);
  });

  /**
   * On a plan small enough that the warning line rounds up to the cap, the
   * notice that actually matters is the one to send.
   */
  it('prefers the limit notice when the two thresholds coincide', async () => {
    const { notifier, sent } = notifierWith({ warnAt: 0.8 });

    await notifier.onVolumeChanged(crossing(1, 1));

    expect(sent.map((message) => message.template)).toEqual(['volume_limit_reached']);
  });

  /**
   * TAR-37's acceptance criterion is that the policy is a documented setting
   * rather than implicit behaviour, and the message a tenant actually receives
   * is where that has to be true: "800 of 1,000" means something very different
   * depending on whether the thousandth stops replies going out.
   */
  it.each(['warn', 'block'] as const)('names the %s policy in the message', async (policy) => {
    const { notifier, sent } = notifierWith({ policy });

    await notifier.onVolumeChanged(crossing(800));

    expect(sent[0]?.data).toMatchObject({ policy, opened: '800', cap: '1000' });
  });

  it('addresses every active admin of the tenant, and only that tenant', async () => {
    const { notifier, sent, findMany } = notifierWith({
      admins: [{ email: 'a@acme.example' }, { email: 'b@acme.example' }],
    });

    await notifier.onVolumeChanged(crossing(800));

    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, role: 'admin', status: 'active' },
      select: { email: true },
    });
    expect(sent.map((message) => message.to)).toEqual(['a@acme.example', 'b@acme.example']);
    expect(sent.every((message) => message.tenantId === TENANT)).toBe(true);
  });

  it('says so rather than failing silently when there is nobody to tell', async () => {
    const { notifier, sent } = notifierWith({ admins: [] });

    await expect(notifier.onVolumeChanged(crossing(800))).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  /**
   * The handler is dispatched from the inbound-message path without an await, so
   * a rejection there is an unhandled rejection about a customer's message that
   * was in fact stored correctly. The notice is a courtesy; the console's banner
   * reads the same numbers from `GET /billing/usage` regardless.
   */
  it('never lets a mailer outage escape into the inbound path', async () => {
    const { notifier } = notifierWith({});

    jest
      .spyOn(notifier as unknown as { notifyAdmins: () => Promise<void> }, 'notifyAdmins')
      .mockRejectedValue(new Error('smtp down'));

    await expect(notifier.onVolumeChanged(crossing(800))).resolves.toBeUndefined();
  });
});

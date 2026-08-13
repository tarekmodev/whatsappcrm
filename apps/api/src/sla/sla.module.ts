import { Module } from '@nestjs/common';
import { SlaAlertService } from './sla-alert.service';
import { SlaAlertsController } from './sla-alerts.controller';
import { SlaPoliciesController } from './sla-policies.controller';
import { SlaPolicyService } from './sla-policy.service';
import { SlaQueueRunner } from './sla-queue.runner';
import { SlaSweepService } from './sla-sweep.service';
import { SlaTimerService } from './sla-timer.service';

/**
 * SLA timers and supervisor alerts (TAR-26), built against
 * `docs/architecture/0006-sla-timers-and-supervisor-alerts.md`.
 *
 * An **L4 module** per 0002's table. It may import L3 domain modules; nothing
 * below it may import it — which is exactly why every trigger reaching it is a
 * queue job rather than a call. `TicketsModule` and `ConversationsModule` both
 * need to tell it something happened and neither may name it, so what crosses
 * the line is the shape in `@whatsappcrm/contracts/sla` and the `sla` queue.
 *
 * It imports nothing at all today: `TenantPrisma` and `SystemPrisma` come from
 * the global `PrismaModule`, `TenantContextService` from `TenantContextModule`,
 * `QueueService` from `QueueModule`, and `EventEmitter2` from the root
 * `EventEmitterModule`.
 *
 * It exports nothing either. Its whole public surface is two HTTP controllers,
 * one queue, and one domain event — `sla.breached`, which `RealtimeModule`
 * subscribes to without importing this module, the same way it subscribes to
 * every other producer.
 *
 * | Provider           | Responsibility                                                              |
 * | ------------------ | --------------------------------------------------------------------------- |
 * | `SlaPolicyService` | Resolves the policy applying to a ticket; reads and updates policies        |
 * | `SlaTimerService`  | Starts, pauses, resumes and stops timers. The only writer outside the sweep |
 * | `SlaSweepService`  | Detects breaches, writes alerts. Decisions 1–3                              |
 * | `SlaAlertService`  | Resolves recipients, reads and acknowledges alerts                          |
 * | `SlaQueueRunner`   | BullMQ registration — the only file here that knows a queue exists          |
 *
 * ## What is not wired yet, and why
 *
 * 0006 names four ticket-level triggers. Three exist: a ticket being created and
 * a customer replying to a paused one are both enqueued by `TicketQueueRunner`,
 * and an agent replying by `MessageSendService`. The fourth — a ticket's status
 * changing — belongs to TAR-25's ticket command service, which has not landed;
 * there is no code path in this repository that changes a ticket's status other
 * than the `pending → open` reopen the linker performs, and that is covered by
 * the customer-reply trigger. When TAR-25 lands it enqueues the same job with
 * `reason: 'status_changed'` and nothing here changes: the handler reconciles
 * from the row.
 */
@Module({
  controllers: [SlaPoliciesController, SlaAlertsController],
  providers: [SlaPolicyService, SlaTimerService, SlaAlertService, SlaSweepService, SlaQueueRunner],
})
export class SlaModule {}

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
 * ## The four triggers, and who produces each
 *
 * | When                                     | Enqueued by             | Reason             |
 * | ---------------------------------------- | ----------------------- | ------------------ |
 * | A ticket is created                      | `TicketQueueRunner`     | `ticket_created`   |
 * | A customer replies to a `pending` ticket | `TicketQueueRunner`     | `customer_replied` |
 * | An outbound message from a person        | `MessageSendService`    | `agent_replied`    |
 * | A ticket's status changes                | `TicketCommandService`  | `status_changed`   |
 *
 * All four enqueue **the same job**, and the handler re-derives the whole timer
 * state from the row rather than branching on `reason` — which is what makes a
 * job that is lost, duplicated or delivered out of order converge on the same
 * state, and what let the fourth producer be added without touching this module.
 * `reason` exists for logs.
 */
@Module({
  controllers: [SlaPoliciesController, SlaAlertsController],
  providers: [SlaPolicyService, SlaTimerService, SlaAlertService, SlaSweepService, SlaQueueRunner],
})
export class SlaModule {}

import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';

/**
 * The generalised notification inbox (TAR-27, 0009 decision 7), built against
 * `docs/architecture/0002-architecture-and-api-contract.md`'s REST table.
 *
 * **A module of its own rather than a controller bolted onto `SlaModule` or
 * `WorkflowsModule`.** The rows it reads have three writers across two L4
 * modules, and a read surface owned by one of them would either import the other
 * — which the layering rule forbids and which would put two features in one
 * failure domain — or quietly claim the table. Owning nothing but the read is
 * what lets it sit below both: it imports no feature module, and no feature
 * module imports it.
 *
 * It imports nothing at all: `TenantPrisma` comes from the global
 * `PrismaModule` and `TenantContextService` from `TenantContextModule`. It
 * exports nothing either — its whole public surface is one HTTP controller.
 *
 * | Provider              | Responsibility                                      |
 * | --------------------- | --------------------------------------------------- |
 * | `NotificationService` | Reads and acknowledges the caller's notifications   |
 *
 * ## What it does not do
 *
 * It does not write. `SlaSweepService` writes `sla_breach` rows,
 * `WorkflowActionExecutor` writes `workflow_notify`, and
 * `WorkflowTriggerService` writes `workflow_broken` — each inside the
 * transaction that makes it true, and each with its own idempotency key. A
 * shared writer here would have to be handed a transaction from three modules
 * that may not name it.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationService],
})
export class NotificationsModule {}

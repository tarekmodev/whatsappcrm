import { Module } from '@nestjs/common';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkflowActionExecutor } from './workflow-action.executor';
import { WorkflowCatalogController } from './workflow-catalog.controller';
import { WorkflowCatalogService } from './workflow-catalog.service';
import { WorkflowElapsedSweep } from './workflow-elapsed.sweep';
import { WorkflowFactSheetService } from './workflow-fact-sheet.service';
import { WorkflowQueueRunner } from './workflow-queue.runner';
import { WorkflowRunService } from './workflow-run.service';
import { WorkflowService } from './workflow.service';
import { WorkflowTriggerService } from './workflow-trigger.service';
import { WorkflowsController } from './workflows.controller';

/**
 * Workflow automation — trigger, condition, action (TAR-27), built against
 * `docs/architecture/0009-workflow-triggers-conditions-actions.md`.
 *
 * An **L4 module** per 0002's ownership table, which already reserved the name.
 * It may import L3 domain modules; nothing below it may import it — which is why
 * every trigger reaching it is a queue job rather than a call.
 *
 * ## Why it is a new module rather than an extension of `SlaModule`
 *
 * The two share a *shape* — a periodic sweep, a per-ticket reconciler — and no
 * data: `SlaModule` owns `sla_policies` and `sla_timers`, this owns `workflows`
 * and `workflow_runs`, and no row is read by both. Merging them would mean a
 * tenant's malformed workflow can fail the job that also detects SLA breaches,
 * and a supervisor reading "SLA sweep failed" would have to know it might mean
 * something else entirely. SLA detection is the platform's contractual-obligation
 * alarm; workflows are tenant-authored code. They do not belong in one failure
 * domain (0009, decision 1).
 *
 * ## Why it imports `TicketsModule`, where `AssignmentModule` imports nothing
 *
 * 0007 rule 5 forbids `AssignmentModule` from importing an L3 module, and that
 * was right there: it writes two assignment columns under a compare-and-set it
 * owns. This module writes ticket **status** and **priority**, and those writes
 * carry `TICKET_STATUS_TRANSITIONS`, `resolved_at`/`closed_at` stamping, the
 * `status_changed` ticket event, the `sla.evaluate-ticket` enqueue that pauses
 * or stops a timer, and the realtime announcement — five behaviours living in
 * `TicketCommandService` today. A second implementation would drift, and the
 * first symptom would be a workflow closing a ticket whose SLA timer never
 * stopped. L4 importing L3 is what 0002's layering rule permits and what
 * `SlaModule` already does.
 *
 * `TicketCommandService` both enqueues into this module's queue and is called by
 * its executor, which reads like a cycle and is not: `WorkflowsModule` imports
 * `TicketsModule`, never the reverse, and the return path is a queue payload
 * defined in `packages/contracts`. The loop that *does* create is real, and
 * `WorkflowTriggerService`'s three bounds are what contain it.
 *
 * | Provider                    | Responsibility                                                              |
 * | --------------------------- | --------------------------------------------------------------------------- |
 * | `WorkflowService`           | CRUD, validation, reference indexing. The only writer of `workflows`        |
 * | `WorkflowCatalogService`    | Serves the trigger / operator / action vocabulary to the console            |
 * | `WorkflowTriggerService`    | Turns one occurrence into candidate workflows, claims a run, executes it    |
 * | `WorkflowFactSheetService`  | One lazy read of everything the conditions can ask about a ticket           |
 * | `WorkflowActionExecutor`    | Executes one action. The only component that writes outside this module     |
 * | `WorkflowElapsedSweep`      | Finds tickets that have met an elapsed trigger. Writes nothing              |
 * | `WorkflowRunService`        | The run history and the dry run                                             |
 * | `WorkflowQueueRunner`       | BullMQ registration — the only file in the module that knows a queue exists |
 *
 * The condition evaluator is deliberately **not** a provider: it is pure
 * functions in `workflow-conditions.ts`, with no database and no framework, so
 * its spec is a readable table of cases rather than a fixture exercise.
 *
 * ## The five triggers, and who produces each
 *
 * | When                              | Enqueued by                | Trigger type            |
 * | --------------------------------- | -------------------------- | ----------------------- |
 * | A ticket is created               | `TicketLinkerService`      | `ticket_created`        |
 * | A ticket's status changes         | `TicketCommandService`     | `ticket_status_changed` |
 * | A ticket changes hands            | `TicketCommandService`     | `ticket_assigned`       |
 * | An SLA timer breaches             | `SlaSweepService`          | `ticket_sla_breached`   |
 * | A ticket crosses an age threshold | `WorkflowElapsedSweep`     | `ticket_unresolved_for` |
 *
 * Everything else comes from global modules — `TenantPrisma` and `SystemPrisma`
 * from `PrismaModule`, `TenantContextService` from `TenantContextModule`,
 * `QueueService` from `QueueModule`, `AuditService` from `AuditModule`.
 */
@Module({
  imports: [TicketsModule],
  controllers: [WorkflowsController, WorkflowCatalogController],
  providers: [
    WorkflowService,
    WorkflowCatalogService,
    WorkflowFactSheetService,
    WorkflowActionExecutor,
    WorkflowTriggerService,
    WorkflowElapsedSweep,
    WorkflowRunService,
    WorkflowQueueRunner,
    ApiExceptionFilter,
  ],
})
export class WorkflowsModule {}

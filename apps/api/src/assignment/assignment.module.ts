import { Module } from '@nestjs/common';
import { FALLBACK_ASSIGNMENT_RESOLVER, TICKET_ROUTER } from '@whatsappcrm/contracts';
import { ApiExceptionFilter } from '../common/errors/api-exception.filter';
import { AssignmentQueueRunner } from './assignment-queue.runner';
import { AssignmentRulesController } from './assignment-rules.controller';
import { AssignmentRulesService } from './assignment-rules.service';
import { RotationFallbackResolver } from './rotation-fallback.resolver';
import { RuleEngineService } from './rule-engine.service';

/**
 * Ticket routing (TAR-39, module map): where a new ticket goes, and who takes
 * it. An **L4 module** — it may read tickets, users and teams through
 * `TenantPrisma`, and it imports no L3 domain module to do so, because that is a
 * read of the database rather than a read of `TicketsModule`. What crosses the
 * line the other way is a queue job: `TicketsModule` enqueues
 * `assignment.route-ticket` and imports nothing from here.
 *
 * ## Both halves are here now
 *
 * Two stories built either side of one token, neither able to see the other's
 * code while it was being written:
 *
 *   * **The rule engine** (TAR-24, TAR-288) — condition rules, their CRUD
 *     surface, and the `assignment.route-ticket` worker that drives the
 *     pipeline. `TICKET_ROUTER` is its contract.
 *   * **Rotation** (TAR-23) — `RotationFallbackResolver`: who takes the next
 *     ticket when no rule claimed it. `FALLBACK_ASSIGNMENT_RESOLVER` is its
 *     contract.
 *
 * Both are tokens rather than classes so each side names the contract instead of
 * the implementation — which is what let them be written in parallel and meet
 * here without either one changing.
 *
 * **0007 anticipated a `NullFallbackAssignmentResolver` bound here until
 * rotation landed. Rotation landed first, so there is no stub in the container
 * and there must not be one.** Binding the token to a stub would answer "nobody
 * available" for every ticket no rule matched — quietly turning rotation off,
 * while every unit test that supplies its own double kept passing. TAR-288's
 * unit tests inject a fake resolver directly, which is where a stub belongs.
 *
 * Everything else comes from global modules — `TenantPrisma` from
 * `PrismaModule`, `TenantContextService` from `TenantContextModule`,
 * `QueueService` from `QueueModule`, `AuditService` from `AuditModule`. No
 * guards are declared: since TAR-58 the three that protect this controller are
 * installed application-wide by `RequestPipelineModule`.
 */
@Module({
  controllers: [AssignmentRulesController],
  providers: [
    AssignmentRulesService,
    ApiExceptionFilter,
    { provide: FALLBACK_ASSIGNMENT_RESOLVER, useClass: RotationFallbackResolver },
    { provide: TICKET_ROUTER, useClass: RuleEngineService },
    AssignmentQueueRunner,
  ],
  exports: [AssignmentRulesService, TICKET_ROUTER, FALLBACK_ASSIGNMENT_RESOLVER],
})
export class AssignmentModule {}

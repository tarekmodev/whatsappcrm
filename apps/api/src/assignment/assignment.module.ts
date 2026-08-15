import { Module } from '@nestjs/common';
import { FALLBACK_ASSIGNMENT_RESOLVER } from '@whatsappcrm/contracts';
import { RotationFallbackResolver } from './rotation-fallback.resolver';

/**
 * Ticket routing (TAR-39, module map): where a new ticket goes, and who takes
 * it. An **L4 module** — it may read tickets, users and teams through
 * `TenantPrisma`, and it imports no L3 domain module to do so, because that is a
 * read of the database rather than a read of `TicketsModule`.
 *
 * Two halves, built by two stories in parallel and meeting over one token:
 *
 *   * **Rotation** (TAR-23) — `RotationFallbackResolver`, here today. Who takes
 *     the next ticket when no rule claimed it.
 *   * **The rule engine** (TAR-24, TAR-288) — condition rules, their CRUD
 *     surface, and the `assignment.route-ticket` worker that drives the whole
 *     pipeline. Not here yet.
 *
 * `FALLBACK_ASSIGNMENT_RESOLVER` is the module's whole public surface, and it is
 * a token rather than the class so the engine names the contract instead of the
 * implementation. 0007 anticipated a `NullFallbackAssignmentResolver` bound here
 * until rotation landed; rotation landed first, so the binding starts real and
 * that stub is only ever a test double — TAR-288's unit tests supply their own
 * rather than the container serving one.
 *
 * Everything the resolver needs comes from global modules: `TenantPrisma` from
 * `PrismaModule`, `TenantContextService` from `TenantContextModule`.
 */
@Module({
  providers: [{ provide: FALLBACK_ASSIGNMENT_RESOLVER, useClass: RotationFallbackResolver }],
  exports: [FALLBACK_ASSIGNMENT_RESOLVER],
})
export class AssignmentModule {}

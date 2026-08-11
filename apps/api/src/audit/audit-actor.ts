import type { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { $Enums } from '../generated/prisma/client';

/**
 * The actor types application code may write (TAR-166).
 *
 * Deliberately narrower than the database enum, which also carries
 * `unattributed`. That value belongs to rows written before attribution existed
 * and to whatever an instance predating this release writes during a rollout —
 * it is a statement about history, and a new row can never truthfully claim it.
 * Excluding it here means no future call site can choose it by accident.
 */
export type AuditActorType = Exclude<$Enums.AuditActorType, 'unattributed'>;

/**
 * The three attribution columns, resolved together because they only make sense
 * together: `audit_logs_actor_attribution` refuses a label on a user row and a
 * user on an operator row.
 */
export interface AuditActor {
  actorType: AuditActorType;
  actorUserId: string | null;
  actorLabel: string | null;
}

/**
 * Reads who is acting from the request scope.
 *
 * From the scope rather than from an argument, and that is the rule rather than
 * a convenience: a service handed an actor can be handed the wrong one, and the
 * table where that mistake lands is the one whose entire value is being right
 * about who did what.
 *
 * The order is the precedence, and it is not arbitrary. A platform operator has
 * no session, so the two sources cannot both be populated on a real request —
 * but checking the operator first means that if a future path ever did carry
 * both, the row records the credential that actually authenticated it rather
 * than a tenant user it was acting on behalf of.
 *
 * `system` is the honest answer for everything else: a queue worker, a sweeper,
 * a webhook consumer. It says the platform's own code acted, with no human
 * behind it — which is different from `unattributed`, and the difference is
 * whether anybody could have been named.
 */
export function resolveAuditActor(tenantContext: TenantContextService): AuditActor {
  const label = tenantContext.platformActorLabel;

  if (label !== null) {
    return { actorType: 'platform_operator', actorUserId: null, actorLabel: label };
  }

  const userId = tenantContext.userId;

  if (userId !== null) {
    return { actorType: 'user', actorUserId: userId, actorLabel: null };
  }

  return { actorType: 'system', actorUserId: null, actorLabel: null };
}

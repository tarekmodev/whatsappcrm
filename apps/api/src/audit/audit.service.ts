import { Injectable } from '@nestjs/common';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import { resolveAuditActor } from './audit-actor';
import type { AuditAction } from './audit.actions';

/** What changed, in a shape an auditor can read six months later. */
export interface AuditEntry {
  action: AuditAction;
  targetType:
    | 'user'
    | 'team'
    | 'invite'
    | 'whatsapp_business_account'
    | 'whatsapp_account'
    | 'assignment_rule'
    | 'custom_field'
    | 'canned_response'
    | 'tenant_domain'
    /**
     * The tenant's own settings row, targeted by its tenant id (TAR-384). The
     * one singleton on this list: there is exactly one per tenant, so there is
     * no other id it could carry.
     */
    | 'tenant_settings'
    | 'workflow';
  targetId: string;
  /**
   * A redacted before/after at most. **Never a secret, a password hash, a token
   * or a message body** — this table is read by support and exported for
   * compliance review, and it is not the place to discover PII.
   */
  metadata?: Prisma.InputJsonValue;
}

/**
 * Writes the audit trail for security-relevant mutations.
 *
 * Takes the caller's transaction client rather than opening its own, which is
 * the point: the audit row commits with the change it describes, or neither
 * does. An audit written after the transaction can be lost to a crash — leaving
 * a role change nobody can account for — and one written before can describe a
 * change that then rolled back.
 *
 * `tenantId` and the actor come from the request scope, not from the caller's
 * arguments, so a service cannot accidentally attribute a change to the wrong
 * person or file it under the wrong tenant.
 *
 * Since TAR-166 the actor is three columns, not one: `actor_type` says which
 * kind of principal acted, and `actor_label` names the operator credential when
 * it was a platform operator. All three are written explicitly on every call —
 * `actor_type` has a database default, and nothing here leans on it.
 */
@Injectable()
export class AuditService {
  constructor(private readonly tenantContext: TenantContextService) {}

  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        tenantId: this.tenantContext.requireTenantId(),
        ...resolveAuditActor(this.tenantContext),
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      },
      select: { id: true },
    });
  }

  /**
   * Several entries as one statement, for a change that touches a set of people
   * at once — a team's membership being replaced (TAR-244).
   *
   * One `INSERT` rather than one per row because these run inside the caller's
   * transaction: a row per affected user is a round trip per affected user on a
   * connection nothing else can use until it commits. `record` above stays the
   * single-entry path rather than delegating here, so the common case keeps the
   * `create` its callers' tests describe.
   *
   * The tenant and the actor are resolved once, which is also the honest shape:
   * every entry in a batch describes the same actor performing the same
   * operation.
   */
  async recordMany(tx: Prisma.TransactionClient, entries: readonly AuditEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const tenantId = this.tenantContext.requireTenantId();
    const actor = resolveAuditActor(this.tenantContext);

    await tx.auditLog.createMany({
      data: entries.map((entry) => ({
        tenantId,
        ...actor,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      })),
    });
  }
}

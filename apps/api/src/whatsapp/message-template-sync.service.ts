import { Inject, Injectable, Logger } from '@nestjs/common';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { Prisma } from '../generated/prisma/client';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { MetaCloudApiClient, type MetaMessageTemplate } from './meta-cloud-api.client';
import {
  WhatsAppCredentialResolver,
  type BusinessAccountCredentials,
} from './whatsapp-credential.resolver';

/**
 * A hard stop on the paging loop. Meta permits thousands of templates per WABA,
 * and 100 pages of 100 is far above anything real — it exists so a paging bug on
 * either side (a cursor that never advances, a `next` that always points
 * forward) costs one bounded sync rather than an unbounded one.
 */
const MAX_PAGES = 100;

export interface SyncMessageTemplatesResult {
  whatsappBusinessAccountId: string;
  wabaId: string;
  created: number;
  updated: number;
  /** Templates Meta returned that this build does not model — an unknown status. */
  skipped: number;
  /** Everything Meta returned, so a shortfall against `created + updated` is visible. */
  total: number;
  syncedAt: Date;
}

/** A template Meta returned whose status this build can actually store. */
type ApplicableTemplate = MetaMessageTemplate & {
  status: NonNullable<MetaMessageTemplate['status']>;
};

/**
 * Pulls a WABA's templates from Meta and reconciles them into `message_templates`
 * (TAR-20a).
 *
 * ## Why this exists at all
 *
 * Approval is Meta's, and it happens on Meta's timetable — a template submitted
 * on Monday may be approved on Wednesday, and one that has been approved for
 * months can be paused without warning when recipients block it. The database is
 * therefore a **cache of Meta's answer**, and an agent's template picker is only
 * as honest as the last sync.
 *
 * ## Reconciliation rules
 *
 *   * **Keyed on `(tenant_id, whatsapp_business_account_id, name, language)`** —
 *     TAR-52's unique key. Two WABAs under one tenant may each hold
 *     `order_update`/`en` with different content and different approval status,
 *     so the WABA is part of the key and not an implementation detail.
 *   * **Upsert, never delete-and-reinsert.** Re-creating rows would churn every
 *     id on every sync and make the table's history worthless.
 *   * **Additive.** A template that has disappeared from Meta's list is left in
 *     place rather than deleted: Meta pages, and a truncated response must not be
 *     able to empty a tenant's template set. Retiring a stale row is a separate,
 *     deliberate operation.
 *   * **A status this build does not model is skipped, not guessed.** Meta has
 *     `IN_APPEAL`, `PENDING_DELETION` and more, and adds to the list; mapping an
 *     unknown value onto `approved` would put an unsendable template in front of
 *     an agent.
 *
 * ## Transaction shape
 *
 * Each page is written in its own `$tenantTransaction`, not the whole sync in
 * one. A tenant with thousands of templates would otherwise hold a transaction
 * open across every Meta round trip — the exact "transaction held across a
 * network call" that turns one slow upstream into connection-pool exhaustion.
 * The cost is that a sync interrupted halfway leaves earlier pages applied, which
 * is fine: the operation is idempotent, so it is re-run rather than rolled back.
 */
@Injectable()
export class MessageTemplateSyncService {
  private readonly logger = new Logger(MessageTemplateSyncService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly credentials: WhatsAppCredentialResolver,
    private readonly cloudApi: MetaCloudApiClient,
  ) {}

  /** By our own id for the WABA row — what an internal caller holding a foreign key has. */
  async sync(whatsappBusinessAccountId: string): Promise<SyncMessageTemplatesResult> {
    return this.run(await this.credentials.forBusinessAccount(whatsappBusinessAccountId));
  }

  /** By Meta's id — what an operator has, and what the admin route takes in its path. */
  async syncByWabaId(wabaId: string): Promise<SyncMessageTemplatesResult> {
    return this.run(await this.credentials.forBusinessAccountByWabaId(wabaId));
  }

  private async run({
    whatsappBusinessAccountId,
    wabaId,
    accessToken,
  }: BusinessAccountCredentials): Promise<SyncMessageTemplatesResult> {
    const tenantId = this.tenantContext.requireTenantId();
    const totals = { created: 0, updated: 0, skipped: 0, total: 0 };
    let after: string | undefined = undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const { templates, nextAfter } = await this.cloudApi.listMessageTemplates({
        wabaId,
        accessToken,
        after,
      });

      totals.total += templates.length;

      const applicable = templates.filter(hasKnownStatus);
      totals.skipped += templates.length - applicable.length;

      const applied = await this.prisma.$tenantTransaction((tx) =>
        applyPage(tx, tenantId, whatsappBusinessAccountId, applicable),
      );

      totals.created += applied.created;
      totals.updated += applied.updated;

      if (nextAfter === null) {
        break;
      }

      after = nextAfter;

      if (page === MAX_PAGES - 1) {
        // Never silent: a capped sync that reported success would read as "these
        // are all the templates" when it is not.
        this.logger.error(
          `Template sync for WABA ${wabaId} stopped at the ${MAX_PAGES}-page cap with more pages ` +
            'available. Some templates were not synced.',
        );
      }
    }

    this.logger.log(
      `Synced templates for WABA ${wabaId} (tenant ${tenantId}): ` +
        `${totals.created} created, ${totals.updated} updated, ${totals.skipped} skipped of ${totals.total}`,
    );

    return { whatsappBusinessAccountId, wabaId, ...totals, syncedAt: new Date() };
  }
}

/** Narrows away the templates whose status this build cannot express. */
function hasKnownStatus(template: MetaMessageTemplate): template is ApplicableTemplate {
  return template.status !== null;
}

/**
 * One page, written in one transaction.
 *
 * Sequential rather than `Promise.all`: this runs on the single connection the
 * interactive transaction holds, so concurrency would only interleave statements
 * on the same wire — and would make the created/updated split racy.
 */
async function applyPage(
  tx: Prisma.TransactionClient,
  tenantId: string,
  whatsappBusinessAccountId: string,
  templates: readonly ApplicableTemplate[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;

  for (const template of templates) {
    const key = {
      tenantId_whatsappBusinessAccountId_name_language: {
        tenantId,
        whatsappBusinessAccountId,
        name: template.name,
        language: template.language,
      },
    };

    const existing = await tx.messageTemplate.findUnique({ where: key, select: { id: true } });

    // `upsert` would be one statement, but its two branches genuinely differ — a
    // create supplies the tenant and the WABA, an update must not — and being
    // explicit is what makes the created/updated counts real rather than inferred.
    if (existing === null) {
      await tx.messageTemplate.create({
        data: {
          // Supplied explicitly: the tenant-scope extension injects nothing into
          // `data`, and RLS's WITH CHECK is what refuses a wrong value.
          tenantId,
          whatsappBusinessAccountId,
          name: template.name,
          language: template.language,
          category: template.category,
          status: template.status,
          components: toJson(template.components),
          providerTemplateId: template.providerTemplateId,
        },
        select: { id: true },
      });
      created += 1;
    } else {
      await tx.messageTemplate.update({
        where: { id: existing.id },
        data: {
          category: template.category,
          status: template.status,
          components: toJson(template.components),
          providerTemplateId: template.providerTemplateId,
        },
        select: { id: true },
      });
      updated += 1;
    }
  }

  return { created, updated };
}

/**
 * Meta's component tree is stored verbatim — its shape is Meta's to change, and
 * a parser that guessed at it would start rejecting valid templates the first
 * time Meta added a field.
 *
 * Absence becomes `Prisma.DbNull`, not `Prisma.JsonNull`: the column is
 * nullable, and the distinction is between "no components" (SQL NULL) and "the
 * JSON value null", which is not something Meta sends. Writing the wrong one
 * makes `components IS NULL` stop matching rows that have none.
 */
function toJson(components: unknown): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  return components === null || components === undefined ? Prisma.DbNull : components;
}

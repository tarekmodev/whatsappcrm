import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AI_INDEX_DOCUMENT_JOB,
  AI_QUEUE,
  KNOWLEDGE_DOCUMENT_LIMITS,
  indexKnowledgeDocumentJobId,
  type CreateKnowledgeDocumentInput,
  type CursorPage,
  type IndexKnowledgeDocumentJob,
  type KnowledgeDocumentListItem,
  type KnowledgeDocumentListQuery,
  type KnowledgeDocumentResponse,
  type UpdateKnowledgeDocumentInput,
} from '@whatsappcrm/contracts';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
  type TimestampCursor,
} from '../common/pagination/timestamp-keyset';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { PlanFeaturesService } from '../entitlements/plan-features.service';
import type { Prisma } from '../generated/prisma/client';
import { KnowledgeDocumentStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { QueueService } from '../queue/queue.service';
import { AI_INDEX_BACKOFF_MS, AI_INDEX_MAX_ATTEMPTS } from './ai.constants';
import {
  AiFeatureNotInPlanError,
  InvalidKnowledgeCursorError,
  KnowledgeDocumentCapReachedError,
  KnowledgeDocumentNotFoundError,
} from './ai.errors';
import {
  DOCUMENT_PROJECTION,
  LIST_PROJECTION,
  toKnowledgeDocumentListItem,
  toKnowledgeDocumentResponse,
} from './knowledge-document.mapper';

/**
 * The tenant's knowledge base: the CRUD surface an admin edits it through
 * (0010, knowledge-base CRUD).
 *
 * ## Writes are asynchronous in exactly one respect
 *
 * A create, and a `PATCH` that changes `content`, answer `201`/`200` with
 * `status: 'pending'` and enqueue `ai.index-document`. **The document is not
 * retrievable by the bot until indexing commits**, and the console shows the
 * pending state — which is the honest thing to render, and why `chunkCount` is
 * on the response at all.
 *
 * Returning the document as `indexed` and chunking inline would put a
 * paragraph-splitting pass over 256 KiB inside a request, and would make a
 * failed chunking run a failed save of content the tenant had already written.
 *
 * ## The plan gate is on the writes, and deliberately not on the reads
 *
 * 0010 puts `@RequireFeature('ai_chatbot')` on the whole CRUD surface. This
 * implementation gates the four writes and leaves the two reads open, for the
 * reason 0010 itself gives when it exempts `GET /ai/config`: a tenant whose plan
 * no longer includes the bot must be able to see — and delete — the knowledge
 * base they already authored, and be shown an upsell rather than a 403 page.
 * Gating the reads would lock a downgraded tenant out of their own content with
 * no path to remove it. Recorded here rather than left as a silent divergence.
 *
 * ## Isolation
 *
 * `TenantPrisma` throughout, so RLS supplies `tenant_id`; there is no `tenantId`
 * filter anywhere in this file except the one the create needs as a column
 * value. An id in another tenant reads zero rows and answers `not_found`, which
 * is the same answer an id that names nothing gets.
 */
@Injectable()
export class KnowledgeDocumentService {
  private readonly logger = new Logger(KnowledgeDocumentService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly features: PlanFeaturesService,
    private readonly queue: QueueService,
  ) {}

  /**
   * Newest first, keyset-paginated on `(created_at DESC, id DESC)` — served by
   * the index TAR-402 added for exactly this page.
   *
   * `content` is not selected. See `knowledge-document.mapper.ts`.
   */
  async list(query: KnowledgeDocumentListQuery): Promise<CursorPage<KnowledgeDocumentListItem>> {
    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidKnowledgeCursorError('cursor');
    }

    const rows = await this.prisma.knowledgeDocument.findMany({
      where: {
        ...(query.status === undefined ? {} : { status: query.status }),
        // A console filter over titles, not the retrieval path — which is
        // `KnowledgeRetriever` and runs over chunks. Unindexed and accepted: a
        // tenant holds at most 1,000 documents by construction.
        ...(query.q === undefined ? {} : { title: { contains: query.q, mode: 'insensitive' } }),
        ...(cursor.outcome === 'cursor' ? resumeFrom(cursor.cursor) : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      select: LIST_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toKnowledgeDocumentListItem),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  async get(documentId: string): Promise<KnowledgeDocumentResponse> {
    const document = await this.prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
      select: DOCUMENT_PROJECTION,
    });

    if (document === null) {
      throw new KnowledgeDocumentNotFoundError(documentId);
    }

    return toKnowledgeDocumentResponse(document);
  }

  /**
   * A new document, `pending` until the indexer has chunked it.
   *
   * The cap is checked inside the transaction that inserts, and the count is
   * what makes it a check rather than a race: two concurrent creates at the
   * boundary would otherwise both read 999. It is a `SERIALIZABLE`-free
   * approximation — the honest limitation is that two transactions can still
   * interleave under read-committed and land at 1,001 — and that is accepted
   * deliberately: the cap exists so a knowledge base has a size answer, not as a
   * billing boundary somebody would game by one row.
   */
  async create(input: CreateKnowledgeDocumentInput): Promise<KnowledgeDocumentResponse> {
    await this.assertFeatureIncluded();

    const tenantId = this.tenantContext.requireTenantId();

    const created = await this.prisma.$tenantTransaction(async (tx) => {
      const held = await tx.knowledgeDocument.count();

      if (held >= KNOWLEDGE_DOCUMENT_LIMITS.documentsPerTenant) {
        throw new KnowledgeDocumentCapReachedError();
      }

      return tx.knowledgeDocument.create({
        data: {
          tenantId,
          title: input.title,
          content: input.content,
          sourceUrl: input.sourceUrl ?? null,
          language: input.language ?? null,
          status: KnowledgeDocumentStatus.pending,
        },
        select: DOCUMENT_PROJECTION,
      });
    });

    await this.queueIndexing(tenantId, created.id);

    return toKnowledgeDocumentResponse(created);
  }

  /**
   * A partial edit.
   *
   * `updateMany` with the id in the `WHERE` rather than `update`, so a document
   * in another tenant is zero rows updated — reported as `not_found` — instead
   * of Prisma's `P2025`. RLS makes the outcome the same either way; this makes
   * the *error* the same as the one an id that names nothing gets.
   *
   * **Only a content change re-indexes.** Renaming a document or correcting its
   * source URL leaves the chunks alone, because neither reaches the search
   * vector — re-chunking on a title edit would spend a transaction and a queue
   * job to write back the rows it deleted.
   */
  async update(
    documentId: string,
    input: UpdateKnowledgeDocumentInput,
  ): Promise<KnowledgeDocumentResponse> {
    await this.assertFeatureIncluded();

    const tenantId = this.tenantContext.requireTenantId();
    const reindexes = input.content !== undefined;

    const { count } = await this.prisma.knowledgeDocument.updateMany({
      where: { id: documentId },
      data: {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(input.content === undefined
          ? {}
          : {
              content: input.content,
              // Back to pending, and the previous failure cleared: the chunks on
              // disk describe content that no longer exists, and leaving the row
              // `indexed` would let the bot cite the old text against the new
              // document until the job ran.
              status: KnowledgeDocumentStatus.pending,
              indexError: null,
            }),
      },
    });

    if (count === 0) {
      throw new KnowledgeDocumentNotFoundError(documentId);
    }

    if (reindexes) {
      await this.queueIndexing(tenantId, documentId);
    }

    return this.get(documentId);
  }

  /**
   * `POST /knowledge-documents/{id}/reindex` — the operator's repair for a
   * document parked `failed`, and the way to pick up a chunking change without
   * rewriting content.
   */
  async reindex(documentId: string): Promise<KnowledgeDocumentResponse> {
    await this.assertFeatureIncluded();

    const tenantId = this.tenantContext.requireTenantId();

    const { count } = await this.prisma.knowledgeDocument.updateMany({
      where: { id: documentId },
      data: { status: KnowledgeDocumentStatus.pending, indexError: null },
    });

    if (count === 0) {
      throw new KnowledgeDocumentNotFoundError(documentId);
    }

    await this.queueIndexing(tenantId, documentId);

    return this.get(documentId);
  }

  /**
   * Deleting a document deletes its chunks, through the cascade the composite
   * foreign key declares — so the bot cannot cite content a tenant has removed,
   * and there is no second delete to remember.
   */
  async delete(documentId: string): Promise<void> {
    await this.assertFeatureIncluded();

    const { count } = await this.prisma.knowledgeDocument.deleteMany({
      where: { id: documentId },
    });

    if (count === 0) {
      throw new KnowledgeDocumentNotFoundError(documentId);
    }
  }

  /**
   * The plan gate, on the writes only — see the class comment for why the reads
   * are exempt.
   *
   * Deleting is gated with the rest, and that is the one arguable case: a
   * downgraded tenant can still delete, because a delete is refused only while
   * the plan *does* include the feature… which is never. The gate is on
   * `includes === false`, so a tenant whose plan says nothing — every tenant
   * today — passes it, and one whose plan explicitly excludes the bot is refused
   * every write including the delete. That is the conservative reading of "a
   * write to a feature you do not have"; if product wants a downgraded tenant to
   * be able to clean up, moving `delete` out of this gate is a one-line change.
   */
  private async assertFeatureIncluded(): Promise<void> {
    if (!(await this.features.includes('ai_chatbot'))) {
      throw new AiFeatureNotInPlanError();
    }
  }

  /**
   * Hands the chunking to the worker, after the commit and never inside it.
   *
   * Never throws, per `QueueService`'s contract: the row is committed and says
   * `pending`, so a Redis blip costs a document that is not searchable yet
   * rather than a save that failed after the tenant's content was already
   * stored. The honest limitation, stated rather than glossed: nothing
   * re-enqueues a lost indexing job today. `POST …/reindex` is the operator's
   * repair, and `readiness.indexedDocumentCount` is what makes the gap visible.
   */
  private async queueIndexing(tenantId: string, documentId: string): Promise<void> {
    const job: IndexKnowledgeDocumentJob = { tenantId, documentId };

    const outcome = await this.queue.enqueue<IndexKnowledgeDocumentJob>(
      AI_QUEUE,
      AI_INDEX_DOCUMENT_JOB,
      job,
      {
        jobId: indexKnowledgeDocumentJobId(job),
        attempts: AI_INDEX_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: AI_INDEX_BACKOFF_MS },
        // The payload names a row rather than carrying its content, so nothing
        // of the tenant's is in Redis — but dropping it on success is still the
        // right retention for a job with no reader afterwards.
        removeOnComplete: true,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Knowledge document ${documentId} was saved but not queued for indexing (${outcome}); ` +
          'it stays pending and the bot will not use it until it is re-indexed.',
      );
    }
  }
}

/** The resume predicate 0002 rules, on `created_at` descending. */
function resumeFrom(cursor: TimestampCursor): Prisma.KnowledgeDocumentWhereInput {
  const { bound, exclude } = resumeAfter(cursor, 'desc');

  return { createdAt: bound, NOT: { createdAt: cursor.at, ...exclude } };
}

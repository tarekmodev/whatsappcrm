import { Inject, Injectable, Logger } from '@nestjs/common';
import { describeFailure } from '../common/describe-failure';
import { KnowledgeDocumentStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { chunkDocument } from './chunk-document';

/**
 * Turns a document into the chunks retrieval reads (0010, `KnowledgeIndexer`).
 *
 * ## Delete-and-insert, in one transaction
 *
 * Re-indexing replaces the document's whole chunk set inside a single
 * transaction, keyed on the document. That is what makes a half-written chunk
 * set impossible: a retrieval running alongside an edit sees the old set or the
 * new one, never a mixture — and a partially re-indexed document is exactly the
 * shape of a confidently wrong answer.
 *
 * The `(tenant_id, document_id, ordinal)` unique constraint is what makes the
 * delete-then-insert safe to retry: a second run of the same job deletes what
 * the first wrote and writes it again, rather than colliding.
 *
 * ## `search_vector` is never written here
 *
 * It is `GENERATED ALWAYS … STORED` from `content`, so PostgreSQL computes it on
 * insert and refuses any attempt to set it. That is the reason the column can
 * never drift from the text it indexes, and the reason this service has nothing
 * to say about it.
 *
 * ## A failure is recorded, not raised at the customer
 *
 * A document whose chunking throws is parked `failed` with the classified reason
 * in `index_error`, and a failed document is never retrieved — so the bot's
 * behaviour degrades to "does not know about this document", which is the
 * conservative direction. The error text is operator-facing and never rendered
 * to a customer.
 */
@Injectable()
export class KnowledgeIndexerService {
  private readonly logger = new Logger(KnowledgeIndexerService.name);

  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  /**
   * Indexes one document. Idempotent: running it twice leaves the same chunk
   * set, which is what lets the job be retried and re-enqueued freely.
   *
   * A document id that reads nothing — deleted between the enqueue and the run,
   * or another tenant's — is a **skip rather than a throw**. It is a correct
   * state that no number of retries changes, and burning the retry budget on it
   * would put a job in the failed set an operator has to triage for nothing.
   */
  async index(documentId: string): Promise<void> {
    const document = await this.prisma.knowledgeDocument.findUnique({
      where: { id: documentId },
      // Exactly what chunking needs. `content` is the large column and the only
      // reason this read is not free, so nothing else is loaded with it.
      select: { id: true, tenantId: true, content: true },
    });

    if (document === null) {
      this.logger.debug(`Knowledge document ${documentId} no longer exists; nothing to index.`);
      return;
    }

    try {
      const chunks = chunkDocument(document.content);

      await this.prisma.$tenantTransaction(async (tx) => {
        await tx.knowledgeChunk.deleteMany({ where: { documentId } });

        if (chunks.length > 0) {
          await tx.knowledgeChunk.createMany({
            data: chunks.map((content, ordinal) => ({
              tenantId: document.tenantId,
              documentId,
              ordinal,
              content,
            })),
          });
        }

        await tx.knowledgeDocument.updateMany({
          where: { id: documentId },
          data: {
            status: KnowledgeDocumentStatus.indexed,
            chunkCount: chunks.length,
            indexError: null,
            indexedAt: new Date(),
          },
        });
      });

      this.logger.debug(`Knowledge document ${documentId} indexed into ${chunks.length} chunk(s).`);
    } catch (error: unknown) {
      await this.recordFailure(documentId, error);
      throw error;
    }
  }

  /**
   * Parks the document `failed` with a classified reason, then lets the original
   * error propagate so BullMQ still applies its retry budget.
   *
   * The status write is deliberately outside the failed transaction — it is what
   * makes the failure visible in the console rather than only in a log line, and
   * it must survive the rollback that produced it. Its own failure is swallowed:
   * a database that cannot record why the first write failed is not something a
   * second throw makes clearer, and the job's real error is the one worth
   * keeping.
   *
   * `describeFailure` rather than the raw message, on the rule this module
   * follows everywhere: it unwraps to a driver code or an error name and never
   * carries a message, so a document whose content is in the exception text
   * cannot put a customer's words into an operator-facing column.
   */
  private async recordFailure(documentId: string, error: unknown): Promise<void> {
    const indexError = describeFailure(error);

    await this.prisma.knowledgeDocument
      .updateMany({
        where: { id: documentId },
        data: { status: KnowledgeDocumentStatus.failed, chunkCount: 0, indexError },
      })
      .catch((secondary: unknown) => {
        this.logger.error(
          `Could not record the indexing failure for knowledge document ${documentId}: ${describeFailure(secondary)}`,
        );
      });
  }
}

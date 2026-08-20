import { Inject, Injectable } from '@nestjs/common';
import { BOT_CONFIDENCE } from '@whatsappcrm/contracts';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/**
 * What the bot is allowed to answer from: the tenant's own knowledge-base
 * chunks, ranked (0010 decision 2).
 *
 * ## Lexical retrieval, in the database we already run
 *
 * `websearch_to_tsquery` over the generated `search_vector`, ranked by
 * `ts_rank_cd`, with a `pg_trgm` `similarity()` pass as a **second retriever**
 * when full-text search returns nothing. No new infrastructure, and — the
 * property that actually decided it — a lexical rank with a floor can say
 * "nothing here answers this". Cosine similarity over embeddings gives a number
 * that is never zero, which would make the floor a tuning exercise rather than a
 * rule, and it is that refusal the empty-knowledge-base criterion rests on.
 *
 * ## The refusal is the point
 *
 * Zero chunks above `rankFloor` means **the model is never called** — no prompt
 * is assembled, no request is sent, no tokens are spent — and the turn becomes
 * `handoff:no_match`. There is no code path on which the model is invoked
 * without tenant knowledge-base content in the prompt, which is what makes
 * "a tenant with an empty knowledge base cannot receive a hallucinated answer" a
 * structural guarantee rather than a prompt-engineering hope.
 *
 * ## The `tenantId` in the `where` is a plan fix, not a second isolation layer
 *
 * RLS already scopes these rows and is the guarantee. It is passed explicitly
 * anyway because a non-leakproof RLS qual cannot be pushed into an index
 * condition, so the planner would otherwise filter after the scan — the same
 * exception the inbox query already documents in `tenancy.md`.
 *
 * Only `failed` and `pending` documents are excluded, by joining on
 * `status = 'indexed'`: a document whose chunks describe content the tenant has
 * since replaced must not be citable while the re-index is queued.
 */
@Injectable()
export class KnowledgeRetrieverService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  /**
   * The top-K chunks for a customer message, best first, or an empty array.
   *
   * Two queries at most, and the second runs only when the first found nothing:
   * full-text search answers the common case, and the trigram pass recovers part
   * of the vocabulary mismatch that is the known weakness of a lexical design —
   * "can I get my money back" against a policy that says "refund".
   *
   * `topRank` is what the confidence score reads, and the two retrievers report
   * it on the same 0–1 scale so the score means one thing regardless of which
   * one answered.
   */
  async retrieve(tenantId: string, query: string): Promise<RetrievedChunk[]> {
    const trimmed = query.trim();

    if (trimmed === '') {
      return [];
    }

    const ranked = await this.searchFullText(tenantId, trimmed);

    return ranked.length > 0 ? ranked : this.searchTrigram(tenantId, trimmed);
  }

  /**
   * The `'simple'` configuration — the literal the generated column was built
   * with, and the only one that can match it.
   *
   * `'simple'` does no stemming. That costs English recall and is the right
   * trade for a bilingual Arabic/English product: a wrong stemmer is worse than
   * none, and the trigram pass below recovers part of what stemming would have
   * given. `knowledge_documents.language` is stored for the console and is
   * deliberately not consulted here.
   *
   * ## The question is turned into an OR of its lexemes, and that is the whole
   * reason this is not one `websearch_to_tsquery` call
   *
   * Every text-to-tsquery parser PostgreSQL ships — `websearch_to_tsquery`,
   * `plainto_tsquery`, `phraseto_tsquery` — **ANDs** the terms it finds. Against
   * a customer's sentence that is a query no chunk can satisfy: "when will I get
   * my refund" requires a passage containing *when*, *will*, *I*, *get*, *my*
   * and *refund* together, so retrieval would return nothing for almost every
   * real message and the bot would hand off every conversation. Verified against
   * a real database rather than reasoned about — `knowledge-retrieval.int-spec.ts`
   * is the case that catches it.
   *
   * So the message is lexed once and its lexemes are OR-ed, which puts the
   * discrimination where 0010 decision 2 intends it: **`ts_rank_cd` ranks, and
   * `rankFloor` refuses.** An AND query would make that floor redundant, which
   * is itself the tell that ranking was meant to decide.
   *
   * It stays fully parameterised. The customer's text reaches the database as a
   * bind parameter and is lexed by `to_tsvector`; only the resulting lexemes are
   * assembled into a query string, each through `quote_literal`, so a message
   * containing `&`, `!` or a quote produces a lexeme rather than an operator.
   * Nothing is interpolated into SQL at any point.
   *
   * A message with no lexemes at all — punctuation, an emoji — makes
   * `string_agg` return NULL, `to_tsquery(NULL)` NULL, and `@@ NULL` unknown, so
   * the query returns no rows. That is the correct refusal rather than an error.
   */
  private async searchFullText(tenantId: string, query: string): Promise<RetrievedChunk[]> {
    return this.prisma.$queryRaw<RetrievedChunk[]>`
      WITH question AS (
        SELECT to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ')) AS query
          FROM unnest(to_tsvector('simple', ${query})) AS t(lexeme, positions, weights)
      )
      SELECT c.id,
             c.document_id      AS "documentId",
             d.title            AS "documentTitle",
             c.ordinal,
             c.content,
             ts_rank_cd(c.search_vector, q.query) AS rank
        FROM knowledge_chunks c
        JOIN knowledge_documents d
          ON d.tenant_id = c.tenant_id
         AND d.id = c.document_id,
             question q
       WHERE c.tenant_id = ${tenantId}::uuid
         AND d.status = 'indexed'
         AND c.search_vector @@ q.query
         AND ts_rank_cd(c.search_vector, q.query) >= ${BOT_CONFIDENCE.rankFloor}
       ORDER BY rank DESC, c.id
       LIMIT ${BOT_CONFIDENCE.topK}
    `;
  }

  /**
   * The second retriever: trigram similarity over the raw text, recovering the
   * misspellings and near-misses `'simple'` cannot lex.
   *
   * Runs only when full-text search found nothing, because it is the more
   * expensive and the less precise of the two — and because a query that matched
   * lexically has already produced a better-grounded answer than a fuzzy one
   * would.
   *
   * ## `word_similarity`, not `similarity`
   *
   * `similarity(a, b)` compares the two strings **whole**. A one-line customer
   * question against a 1,200-character chunk scores near zero however well the
   * question matches one sentence of it, so the fallback would never fire —
   * silently, since an empty result is indistinguishable from "nothing matched".
   * `word_similarity(query, content)` scores the query against the best extent
   * of the content, which is the question this retriever is actually asking.
   *
   * ## The index does not serve this predicate, and that is accepted
   *
   * `knowledge_chunks_content_trgm_idx` can serve `<%`, which reads its
   * threshold from the `pg_trgm.word_similarity_threshold` session GUC rather
   * than from a value in the statement. Depending on a session setting for the
   * floor that decides whether a customer gets an answer is worse than a scan:
   * the floor is a published constant the console and the tests read, and a GUC
   * that drifted would move it silently. So the threshold is written into the
   * statement and this path scans the tenant's chunks — hundreds of rows by
   * construction, on a query that only runs when full-text search already found
   * nothing. If a tenant's knowledge base ever grows past that, the fix is to
   * align `trigramFloor` with the GUC and switch to `<%`.
   *
   * `word_similarity` returns 0–1 while `ts_rank_cd` does not, so the score is
   * rescaled onto the same axis: a similarity at the floor maps to the rank
   * floor and a perfect match to the rank target. Without that, the same
   * `minConfidence` would mean two different things depending on which retriever
   * answered — which is precisely the kind of silent inconsistency an admin
   * could never debug.
   */
  private async searchTrigram(tenantId: string, query: string): Promise<RetrievedChunk[]> {
    const rows = await this.prisma.$queryRaw<TrigramRow[]>`
      SELECT c.id,
             c.document_id AS "documentId",
             d.title       AS "documentTitle",
             c.ordinal,
             c.content,
             word_similarity(${query}, c.content) AS similarity
        FROM knowledge_chunks c
        JOIN knowledge_documents d
          ON d.tenant_id = c.tenant_id
         AND d.id = c.document_id
       WHERE c.tenant_id = ${tenantId}::uuid
         AND d.status = 'indexed'
         AND word_similarity(${query}, c.content) >= ${BOT_CONFIDENCE.trigramFloor}
       ORDER BY similarity DESC, c.id
       LIMIT ${BOT_CONFIDENCE.topK}
    `;

    return rows.map(({ similarity, ...chunk }) => ({
      ...chunk,
      rank: rescaleSimilarity(similarity),
    }));
  }
}

/**
 * One chunk the bot may quote, with the rank the confidence score reads.
 *
 * `documentTitle` rides along because the handoff DTO publishes the *documents*
 * the bot cited, and resolving them afterwards would be a second query for
 * something this one already joined.
 */
export interface RetrievedChunk {
  readonly id: string;
  readonly documentId: string;
  readonly documentTitle: string;
  readonly ordinal: number;
  readonly content: string;
  /** `ts_rank_cd`, or a trigram similarity rescaled onto the same axis. */
  readonly rank: number;
}

interface TrigramRow extends Omit<RetrievedChunk, 'rank'> {
  readonly similarity: number;
}

/**
 * Maps `[trigramFloor, 1]` onto `[rankFloor, rankTarget]`, so both retrievers
 * feed the confidence score on one scale.
 *
 * Linear, and deliberately so: the alternative is a curve nobody could justify
 * the shape of, and both endpoints are starting values rather than measurements
 * in the first place.
 */
function rescaleSimilarity(similarity: number): number {
  const span = 1 - BOT_CONFIDENCE.trigramFloor;
  const position = Math.min(Math.max(similarity - BOT_CONFIDENCE.trigramFloor, 0), span) / span;

  return (
    BOT_CONFIDENCE.rankFloor + position * (BOT_CONFIDENCE.rankTarget - BOT_CONFIDENCE.rankFloor)
  );
}

import type { TenantJobData } from '../queue/queue.service';

/**
 * The inbound-download job.
 *
 * Keyed on `messageAttachmentId` — a durable row id, per TAR-39's rule that
 * every job is — rather than on Meta's media handle. The row is what records
 * that the download is owed, so a worker that crashed, a Meta webhook retry and
 * a future retry sweep all name the same thing, and the row's own
 * `download_state` decides which of them does the work.
 *
 * `tenantId` is non-null here, unlike the webhook jobs: by the time an
 * attachment row exists the payload has already been routed to a tenant. The
 * worker needs it to open the scope `TenantPrisma` reads before it can load the
 * row at all.
 *
 * `whatsappAccountId` rides along rather than being looked up from the
 * attachment's conversation. It is one join saved on every media message, and
 * the number a message arrived on cannot change after the fact — so carrying it
 * is not a cache that can go stale.
 */
export interface DownloadInboundMediaJob extends TenantJobData {
  readonly tenantId: string;
  readonly messageAttachmentId: string;
  readonly whatsappAccountId: string;
}

/**
 * Collapses a webhook replay and a re-enqueue of the same attachment into one
 * queued job.
 *
 * An optimisation, not the correctness mechanism — BullMQ forgets an id once
 * the job leaves the completed set, so the same attachment can legitimately be
 * queued again later. What prevents a second download is the `download_state`
 * check the handler makes first.
 *
 * Hyphens, never a colon: BullMQ reserves `:` for its own Redis key structure
 * and rejects a custom job id containing one, at `add()` time — the one call
 * that is allowed to fail without failing the request, and therefore the one
 * place a silent regression would hide.
 */
export function downloadInboundMediaJobId(messageAttachmentId: string): string {
  return `media-download-${messageAttachmentId}`;
}

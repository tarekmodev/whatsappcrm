/**
 * Queue, job and form-field names for the media pipeline.
 *
 * String constants rather than an enum, for the reason `queue.constants.ts`
 * gives: these are wire values. A job already in Redis when a deploy lands
 * still names itself with the old string, and the multipart field name is part
 * of a published HTTP contract.
 */

/**
 * A queue of its own, not `webhooks`.
 *
 * A media download is minutes of transfer against a five-minute window; webhook
 * processing is milliseconds of database work against Meta's retry schedule.
 * On one queue the slow job's concurrency budget is the fast job's, and a burst
 * of large documents would delay every message in the inbox behind them. Two
 * queues also means the two can be sized, paused and alerted on separately,
 * which is what an operator actually wants during an incident.
 */
export const MEDIA_QUEUE = 'media';

/** Download one inbound attachment's bytes from Meta, named by attachment id. */
export const DOWNLOAD_INBOUND_MEDIA_JOB = 'media.download-inbound';

/** The multipart field `POST /api/v1/media` reads the file from. */
export const MEDIA_UPLOAD_FIELD = 'file';

import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';
import { InboundMediaDownloadService } from './inbound-media-download.service';
import { DOWNLOAD_INBOUND_MEDIA_JOB, MEDIA_QUEUE } from './media.constants';
import type { DownloadInboundMediaJob } from './media-jobs';

/**
 * Two downloads at a time.
 *
 * A transfer spends nearly all of its time waiting on the network, so a
 * concurrency of one would make a single 100 MB document block every other
 * message's picture behind it. Two is a starting point chosen to be raised on
 * evidence rather than a tuned value — the ceiling that matters is memory, and
 * nothing here buffers, so the real constraint is the connection pool this
 * shares with the rest of the process.
 */
const DOWNLOAD_CONCURRENCY = 2;

/**
 * Where the media pipeline meets BullMQ, and the only file in this module that
 * knows a queue exists.
 *
 * The same arrangement as `WebhookQueueRunner`, for the same reason: keeping
 * the wiring here rather than decorating the service means
 * `InboundMediaDownloadService` is a plain class a unit test calls directly —
 * no queue, no Redis, no framework — which is what makes the retry and
 * idempotency cases testable at all.
 *
 * Registration happens on application bootstrap rather than in a constructor,
 * so a worker never starts before the providers it dispatches into resolve.
 */
@Injectable()
export class MediaQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(MediaQueueRunner.name);

  constructor(
    private readonly queue: QueueService,
    private readonly downloads: InboundMediaDownloadService,
  ) {}

  onApplicationBootstrap(): void {
    const started = this.queue.registerWorker<DownloadInboundMediaJob>({
      queue: MEDIA_QUEUE,
      concurrency: DOWNLOAD_CONCURRENCY,
      handlers: {
        // `attemptsMade` is zero on the first run, so it is turned into a
        // one-based attempt number here — the service reasons in "attempt 1 of
        // 3", which is what its configuration and its log lines say.
        [DOWNLOAD_INBOUND_MEDIA_JOB]: async (job) =>
          await this.downloads.download(job.data, job.attemptsMade + 1),
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Inbound messages still land in the inbox
      // and their attachments are still recorded — nothing is lost — but the
      // bytes stay `pending` until a process with Redis picks them up, and
      // Meta's five-minute window will have closed long before that.
      this.logger.warn(
        'No media worker started: inbound attachments will be recorded but never downloaded ' +
          'until REDIS_URL is set.',
      );
    }
  }
}

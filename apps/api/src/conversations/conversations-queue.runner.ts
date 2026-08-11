import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { QueueService } from '../queue/queue.service';
import { CONVERSATIONS_QUEUE, SEND_OUTBOUND_MESSAGE_JOB } from './conversations.constants';
import { OutboundMessageDispatcher } from './outbound-message.dispatcher';
import type { SendOutboundMessageJob } from './outbound-message.jobs';

/**
 * Four sends at a time.
 *
 * A send is one outbound HTTPS call plus, for media, an upload — almost all of
 * it spent waiting on Meta. One at a time would put every tenant's replies
 * behind whichever send is slowest, which for a 100 MB document is a long way
 * behind. Four is a starting point to raise on evidence: the ceiling that
 * matters is Meta's per-number rate limit, which is per business account rather
 * than per process, so more workers do not buy throughput past it — they only
 * arrive at the throttle sooner.
 */
const SEND_CONCURRENCY = 4;

/**
 * Where the outbound path meets BullMQ, and the only file in this module that
 * knows a queue exists.
 *
 * The same arrangement as `MediaQueueRunner` and `WebhookQueueRunner`, for the
 * same reason: keeping the wiring here means `OutboundMessageDispatcher` is a
 * plain class a unit test calls directly, which is what makes the retry and
 * redelivery cases testable at all.
 *
 * Registration happens on application bootstrap rather than in a constructor,
 * so a worker never starts before the providers it dispatches into resolve.
 */
@Injectable()
export class ConversationsQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConversationsQueueRunner.name);

  constructor(
    private readonly queue: QueueService,
    private readonly dispatcher: OutboundMessageDispatcher,
  ) {}

  onApplicationBootstrap(): void {
    const started = this.queue.registerWorker<SendOutboundMessageJob>({
      queue: CONVERSATIONS_QUEUE,
      concurrency: SEND_CONCURRENCY,
      handlers: {
        // `attemptsMade` is zero on the first run, so it is turned into a
        // one-based attempt number here — the dispatcher reasons in "attempt 1
        // of 3", which is what its constants and its log lines say.
        [SEND_OUTBOUND_MESSAGE_JOB]: async (job) =>
          await this.dispatcher.deliver(job.data, job.attemptsMade + 1),
      },
    });

    if (!started) {
      // Said once, loudly, at boot. The API still accepts a send and still
      // records it — nothing is lost — but the message sits in `queued` and the
      // customer receives nothing until a process with Redis picks it up.
      this.logger.warn(
        'No outbound message worker started: replies will be accepted and recorded but never ' +
          'delivered until REDIS_URL is set.',
      );
    }
  }
}

import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  AI_HANDLE_INBOUND_JOB,
  AI_QUEUE,
  ASSIGNMENT_QUEUE,
  ASSIGNMENT_ROUTE_JOB,
  InboundMessageTicketTriggerSchema,
  SLA_EVALUATE_TICKET_JOB,
  SLA_QUEUE,
  TICKET_ENSURE_JOB,
  TICKET_LINKER,
  TICKET_QUEUE,
  WORKFLOWS_QUEUE,
  WORKFLOW_EVALUATE_TICKET_JOB,
  assignmentRouteJobId,
  botInboundJobId,
  type BotInboundTrigger,
  type InboundMessageTicketTrigger,
  type SlaEvaluateReason,
  type SlaEvaluateTicketTrigger,
  type TicketLinkResult,
  type TicketLinker,
  type TicketRoutingTrigger,
  type WorkflowEvaluateTicketTrigger,
} from '@whatsappcrm/contracts';
import { UnrecoverableError } from 'bullmq';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import { QueueService } from '../queue/queue.service';

/**
 * Where auto-ticketing meets BullMQ, and the only file in this module that knows
 * a queue exists.
 *
 * The same arrangement as `WebhookQueueRunner` and `MediaQueueRunner`, for the
 * same reason: keeping the wiring here rather than decorating the service means
 * `TicketLinkerService` stays a plain class a unit test calls directly — no
 * queue, no Redis, no framework — which is what made TAR-75's race and
 * idempotency cases testable before this runner existed at all.
 *
 * Registration happens on application bootstrap rather than in a constructor, so
 * a worker never starts before the providers it dispatches into resolve.
 */
@Injectable()
export class TicketQueueRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(TicketQueueRunner.name);

  constructor(
    private readonly queue: QueueService,
    @Inject(TICKET_LINKER) private readonly linker: TicketLinker,
  ) {}

  onApplicationBootstrap(): void {
    const started = this.queue.registerWorker<InboundMessageTicketTrigger>({
      queue: TICKET_QUEUE,
      // The repo default of one, left explicit rather than tuned. 0003 names a
      // convoy on `ticket_counters` as the known cost of the create path — two
      // messages from the same contact can briefly queue every other ticket
      // creation in that tenant behind them — so parallelism here buys less than
      // it looks like it does, and the document's own next step is an advisory
      // lock rather than a wider worker. Raise on evidence from TAR-78.
      concurrency: 1,
      handlers: {
        [TICKET_ENSURE_JOB]: async (job) => {
          await this.ensureTicket(job.data);
        },
      },
    });

    if (!started) {
      // Said once, loudly, at boot. Inbound messages still land in the inbox and
      // nothing is lost — but no conversation becomes a ticket until a process
      // with Redis picks the queue up, and an agent looking at a ticket list
      // would see an empty one while the inbox filled.
      this.logger.warn(
        'No ticket worker started: inbound messages will land in the inbox but will not open ' +
          'tickets until REDIS_URL is set.',
      );
    }
  }

  /**
   * One trigger, validated and linked.
   *
   * The tenant scope every statement below runs in was opened by `QueueService`
   * from `job.data.tenantId` before this was called, which is why nothing here
   * touches `TenantContextService`: a worker that opened its own scope would be
   * a second place the rule lives, and the one that forgot would be the leak.
   *
   * The payload is treated as unvalidated input rather than as the type the
   * generic claims, because that is what it is — JSON read back out of Redis,
   * possibly written by an older deploy.
   */
  private async ensureTicket(data: unknown): Promise<void> {
    const parsed = InboundMessageTicketTriggerSchema.safeParse(data);

    if (!parsed.success) {
      // 0003: a malformed payload fails loudly rather than writing garbage.
      // Unrecoverable because no number of retries changes the shape of a
      // payload that is already in Redis — it goes straight to the failed set,
      // which is the thing being monitored, instead of spending five attempts
      // first.
      throw new UnrecoverableError(
        `Malformed ${TICKET_ENSURE_JOB} payload: ${parsed.error.message}`,
      );
    }

    const trigger = parsed.data;

    try {
      const result = await this.linker.ensureTicketForMessage(trigger);

      this.logger.debug(
        `Message ${trigger.messageId} ${result.outcome}` +
          (result.ticketNumber === null ? '' : ` ticket #${result.ticketNumber}`),
      );

      // Three independent consequences of the same linked message, and all three
      // are enqueues rather than in-process calls: SLA timers (TAR-26), routing
      // (TAR-24), workflow automation (TAR-27) and the AI chatbot (TAR-28). None
      // can fail the message — each logs and moves on — so the order between
      // them carries no meaning beyond reading order.
      await this.triggerSlaEvaluation(trigger.tenantId, result);
      await this.requestRouting(trigger, result);
      await this.triggerWorkflowEvaluation(trigger.tenantId, result);
      await this.triggerBot(trigger, result);
    } catch (error: unknown) {
      if (error instanceof TenantNotActiveError) {
        // 0003's error table: non-retryable, and discarded rather than failed.
        // Deactivation retains data and revokes access (TAR-51), so this is a
        // state an operator deliberately created rather than a fault to alert
        // on — and spending the retry budget on a tenant that is gone helps
        // nobody. The message itself is untouched and the ticket can be opened
        // if the tenant is ever reactivated.
        this.logger.warn(
          `Ticket trigger for message ${trigger.messageId} dropped: ${error.message}`,
        );
        return;
      }

      // Everything else is retryable by contract — most often a job that
      // overtook the transaction that wrote its message. Rethrown so BullMQ
      // applies its backoff, and so an exhausted budget lands in the failed set.
      throw error;
    }
  }

  /**
   * Two of 0006's four SLA triggers, both produced here (TAR-26).
   *
   * A ticket that was **created** needs its timers started; one that was
   * **attached to while `pending`** has just had the customer reply, which is
   * the cue to resume a paused timer. `previousStatus` carries that fact out of
   * the linker precisely so this does not have to re-read the row.
   *
   * An `attached` on an already-open ticket enqueues nothing: nothing about the
   * SLA changed, and a job per inbound message on a busy thread would be a
   * reconciliation that always finds the same state.
   *
   * ## Why here rather than inside `TicketLinkerService`
   *
   * This runner is documented as the only file in the module that knows a queue
   * exists, and that is what keeps the linker a plain class a unit test calls
   * directly. It also keeps the enqueue outside the linker's transaction, which
   * is where it has to be: a job that reached a worker before the ticket
   * committed would read no ticket and burn a retry.
   *
   * Failure to enqueue is logged, never thrown. The ticket is committed, and
   * throwing would have BullMQ retry `ticket.ensure-for-message` — re-running
   * the linker to fix an SLA job, which is the wrong repair. The honest
   * limitation, stated rather than glossed: nothing re-enqueues a lost
   * evaluation today. A ticket whose trigger was lost gets no timers until
   * something else evaluates it, which is a narrower gap than it sounds — the
   * customer's next message produces another trigger — but it is a real one, and
   * a sweep for ticket-with-no-timer is this story's recorded follow-up.
   */
  private async triggerSlaEvaluation(tenantId: string, result: TicketLinkResult): Promise<void> {
    const reason = slaReasonFor(result);

    if (reason === null || result.ticketId === null) {
      return;
    }

    const trigger: SlaEvaluateTicketTrigger = { tenantId, ticketId: result.ticketId, reason };

    const outcome = await this.queue.enqueue<SlaEvaluateTicketTrigger>(
      SLA_QUEUE,
      SLA_EVALUATE_TICKET_JOB,
      trigger,
      {
        // No custom `jobId`, deliberately — see the note in
        // `@whatsappcrm/contracts/sla`. A ticket-keyed id silently collapsed
        // every trigger after the first into the completed key of the one
        // before it, and the handler is a reconciler, so an id buys nothing.
        //
        // Retried, because the ticket is durable and the timer is owed: a job
        // that overtook its own transaction succeeds on the next attempt.
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Ticket ${result.ticketId} was linked but its SLA evaluation was not queued (${outcome}); ` +
          'no timer will be started until it is evaluated again.',
      );
    }
  }

  /**
   * A ticket that was just **created** is a `ticket_created` occurrence
   * (TAR-27, 0009 delta 2).
   *
   * Only `created`. An inbound message attaching to an existing ticket is not a
   * new ticket, and the dedupe key for this trigger is `ticket:{id}` — once per
   * ticket, ever — so an `attached` outcome could only ever produce a claim that
   * conflicts.
   *
   * `occurrenceId` is null for the same reason: the ticket *is* the occurrence.
   * There is no `ticket_events` row to name, and inventing one would make the
   * key say "once per creation event" about a thing that happens once.
   *
   * A refused enqueue is logged, never thrown — the ticket is committed, and
   * throwing would have BullMQ re-run the linker to fix an automation job, which
   * is the wrong repair. **This trigger has no reconciler** (0009, risk 3): a
   * ticket whose `ticket_created` job was lost during a Redis outage gets no
   * automation for its creation, ever. Elapsed triggers self-heal; this does
   * not, and the named fix is a backstop sweep the unique key already makes safe
   * to run.
   */
  private async triggerWorkflowEvaluation(
    tenantId: string,
    result: TicketLinkResult,
  ): Promise<void> {
    if (result.outcome !== 'created' || result.ticketId === null) {
      return;
    }

    const trigger: WorkflowEvaluateTicketTrigger = {
      tenantId,
      ticketId: result.ticketId,
      triggerType: 'ticket_created',
      occurrenceId: null,
      depth: 0,
      causedByRunId: null,
    };

    const outcome = await this.queue.enqueue<WorkflowEvaluateTicketTrigger>(
      WORKFLOWS_QUEUE,
      WORKFLOW_EVALUATE_TICKET_JOB,
      trigger,
      {
        // No custom `jobId` — see the note in `@whatsappcrm/contracts/workflows`,
        // and the identical one in `sla.ts` that this repo has already been
        // bitten by once.
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Ticket ${result.ticketId} was created but its workflow evaluation was not queued ` +
          `(${outcome}); no ticket_created automation will run for it.`,
      );
    }
  }

  /**
   * A ticket that was just **created** asks to be routed (TAR-24, 0007
   * decision 1). The one place these two stories touch, named in 0007's phase
   * table so it is reviewed rather than discovered during integration.
   *
   * Three things about where this sits:
   *
   *   * **`created` only.** An `attached` message joins a ticket somebody may
   *     already be working, and re-routing that is worse than not routing it
   *     (0007, risk 2). A `skipped` outbound message never had a ticket.
   *   * **After the linking transaction has committed**, because it is called
   *     from here rather than from inside `TicketLinkerService`. A routing job
   *     that overtook its own ticket's commit would read nothing and burn a
   *     retry.
   *   * **In this file, not that one.** `TicketLinkerService` stays a plain
   *     class with no queue in it, which is the property that makes TAR-75's
   *     race and idempotency cases unit-testable.
   *
   * `enqueue` reports rather than throws, so a Redis outage leaves the ticket
   * created and unrouted instead of failing the message that created it. The
   * ticket is durable and the job can be replayed; a lost ticket could not be.
   */
  private async requestRouting(
    trigger: InboundMessageTicketTrigger,
    result: TicketLinkResult,
  ): Promise<void> {
    if (result.outcome !== 'created' || result.ticketId === null) {
      return;
    }

    const routing: TicketRoutingTrigger = {
      tenantId: trigger.tenantId,
      ticketId: result.ticketId,
      contactId: trigger.contactId,
      // The message that opened the ticket, so a `keyword` condition matches it
      // rather than whichever message is newest when the worker runs.
      messageId: trigger.messageId,
      createdAt: trigger.receivedAt,
    };

    const outcome = await this.queue.enqueue(ASSIGNMENT_QUEUE, ASSIGNMENT_ROUTE_JOB, routing, {
      jobId: assignmentRouteJobId(routing),
    });

    if (outcome === 'failed' || outcome === 'unavailable') {
      this.logger.warn(
        `Ticket ${result.ticketId} was created but not queued for routing (${outcome}): ` +
          'it will stay unassigned until a routing job runs for it.',
      );
    }
  }

  /**
   * The AI chatbot's trigger (TAR-28, 0010 decision 1) — the third fan-out, and
   * the entire change this story makes to `TicketsModule`.
   *
   * **After the linking transaction, and from here rather than from the inbound
   * writer.** Three things fall out of that placement, and all three are the
   * reason for it:
   *
   *   * **The bot gets a `ticketId`.** It needs one to move the ticket to
   *     `pending` after a successful reply — which is what pauses the SLA clock
   *     and stops a perfectly-answered conversation paging a supervisor — and to
   *     re-request routing on handoff.
   *   * **It inherits the inbound-only, once-per-message filter for free.**
   *     `WhatsAppInboundWriter` already decided that outbound status
   *     placeholders never reach this chain, and `skipped` already means "no
   *     ticket, nothing to do".
   *   * **It cannot race the ticket's commit.** A trigger fired in parallel from
   *     the inbound writer could reach a worker first, and the `pending`
   *     transition would then silently not happen — a correctness bug that
   *     appears only under load.
   *
   * `created` and `attached`, never `skipped`: an attached message is a
   * customer's follow-up on a live thread, which is exactly the conversation a
   * bot should still be answering.
   *
   * The cost of the coupling, stated rather than glossed: a broken or backed-up
   * ticket pipeline also stops the bot. The bot is an accelerator on top of a
   * pipeline that already has to work, and `ai` queue depth is monitored
   * separately for that reason.
   */
  private async triggerBot(
    trigger: InboundMessageTicketTrigger,
    result: TicketLinkResult,
  ): Promise<void> {
    if (result.outcome === 'skipped') {
      return;
    }

    const bot: BotInboundTrigger = {
      tenantId: trigger.tenantId,
      conversationId: trigger.conversationId,
      contactId: trigger.contactId,
      messageId: trigger.messageId,
      ticketId: result.ticketId,
      receivedAt: trigger.receivedAt,
    };

    const outcome = await this.queue.enqueue<BotInboundTrigger>(
      AI_QUEUE,
      AI_HANDLE_INBOUND_JOB,
      bot,
      {
        jobId: botInboundJobId(bot),
        attempts: 2,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: 1_000,
        removeOnFail: 5_000,
      },
    );

    if (outcome === 'failed' || outcome === 'unavailable') {
      // Degrades to exactly the pre-TAR-28 product: the message is committed, the
      // ticket exists, and a human answers. Logged at `debug` rather than `warn`
      // because it is also the ordinary state of every deployment that has not
      // configured a chatbot, and a warning per inbound message would drown the
      // ones that matter.
      this.logger.debug(
        `Message ${trigger.messageId} was linked but not queued for the chatbot (${outcome}); ` +
          'it will be handled by a human.',
      );
    }
  }
}

/** Which of 0006's reasons this link outcome is, or `null` when it is none of them. */
function slaReasonFor(result: TicketLinkResult): SlaEvaluateReason | null {
  if (result.outcome === 'created') {
    return 'ticket_created';
  }

  return result.outcome === 'attached' && result.previousStatus === 'pending'
    ? 'customer_replied'
    : null;
}

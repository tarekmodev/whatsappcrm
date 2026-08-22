import { Injectable, Logger } from '@nestjs/common';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import {
  WebhookEventsRepository,
  type WebhookEventReplayOutcome,
} from '../webhook-events.repository';

/**
 * The operator half of TAR-67's recovery path: resolve who is asking, reset the
 * parked row, leave a trail (TAR-94).
 *
 * It exists as a service rather than as three lines in the controller for one
 * reason, and it is the important one: **the operator's identity comes from the
 * request scope, never from the request.** `PlatformAdminGuard` publishes the
 * label of the credential that actually authenticated the call, and this reads
 * it there — the same rule `resolveAuditActor` states for `audit_logs`, for the
 * same reason. A trail whose actor could be supplied by the caller records who
 * the caller said they were.
 *
 * Everything else about the replay — the guarded reset, the trail row, the one
 * transaction they share — belongs to `WebhookEventsRepository`, which is the
 * only class in this module that reaches `webhook_events` at all.
 */
@Injectable()
export class WebhookEventReplayService {
  private readonly logger = new Logger(WebhookEventReplayService.name);

  constructor(
    private readonly events: WebhookEventsRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Replays one parked event, or reports why it did not.
   *
   * The outcome is returned rather than thrown because none of the three is a
   * fault: an unknown id and a row that is not parked are both answers, and the
   * controller owns which status code each carries.
   */
  async replay(webhookEventId: string): Promise<WebhookEventReplayOutcome> {
    const actorLabel = this.tenantContext.platformActorLabel;

    if (actorLabel === null) {
      // Unreachable behind `PlatformAdminGuard`, which sets the label before the
      // handler runs. Refused rather than defaulted to something like `unknown`:
      // a trail row that cannot name who acted is exactly the gap TAR-166
      // closed, and quietly writing one back into the table would be worse than
      // a 500 nobody should ever see.
      throw new Error(
        'Webhook event replay reached the service with no platform actor in scope; ' +
          'the route is missing PlatformAdminGuard.',
      );
    }

    const outcome = await this.events.replay(webhookEventId, actorLabel);

    if (outcome.kind !== 'replayed') {
      // Warn rather than debug: a refusal here is an operator being told "no"
      // mid-incident, and the next thing they do is ask why.
      this.logger.warn(
        `Refused a replay of webhook event ${webhookEventId}: ${describeRefusal(outcome)}`,
      );

      return outcome;
    }

    // Worth a line every time, unconditionally: this is a hand-triggered reset
    // of production state, and the log is where it sits beside the sweep that
    // picks it up a moment later.
    this.logger.log(
      `Replayed webhook event ${webhookEventId} for ${actorLabel}; parked with ` +
        `${outcome.event.parkedError ?? 'no recorded reason'}. The next sweep will collect it.`,
    );

    return outcome;
  }
}

/** The refusal, for the log line only — the response says it in its own words. */
function describeRefusal(
  outcome: Exclude<WebhookEventReplayOutcome, { kind: 'replayed' }>,
): string {
  return outcome.kind === 'not-found' ? 'no such event' : `it is ${outcome.status}, not parked`;
}

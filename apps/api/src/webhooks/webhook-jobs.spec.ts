import { processWebhookEventJobId } from './webhook-jobs';

describe('processWebhookEventJobId', () => {
  it('is stable for a row, so a retry and a sweeper re-enqueue collapse into one job', () => {
    const id = '019fed4b-271c-708f-8788-97dfb7cf6320';

    expect(processWebhookEventJobId(id)).toBe(processWebhookEventJobId(id));
  });

  it('distinguishes two rows', () => {
    expect(processWebhookEventJobId('a')).not.toBe(processWebhookEventJobId('b'));
  });

  /**
   * Regression guard. BullMQ reserves `:` for its own Redis key structure and
   * rejects a custom job id containing one — and it rejects it inside `add()`,
   * which this pipeline deliberately allows to fail without failing the request.
   * A colon here would therefore disable the queue silently: every delivery
   * would still answer 200, and every event would sit in `received` until the
   * sweeper picked it up, one interval late, for ever.
   */
  it('contains no colon, which BullMQ refuses in a custom job id', () => {
    expect(processWebhookEventJobId('019fed4b-271c-708f-8788-97dfb7cf6320')).not.toContain(':');
  });
});

/**
 * The failures the inbox produces, as typed domain errors rather than
 * `HttpException`s.
 *
 * The same split `people.errors.ts` and `whatsapp.errors.ts` make, for the same
 * reason: a service has no business choosing a status code, and
 * `conversations.http.ts` is the one place that decides. Anything not listed
 * here reaches the caller as a 500, which is the correct answer for a fault.
 *
 * **Nothing here ever carries a message body or a customer's phone number.**
 * These messages are read by agents, logged, and shipped to the error tracker.
 */

export abstract class ConversationError extends Error {
  protected constructor(message: string) {
    super(message);
    // `Error` breaks the prototype chain when a class extending it is
    // down-levelled, which would make `instanceof` lie in a Jest matcher.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = new.target.name;
  }
}

/**
 * The conversation does not exist, is in another tenant, or is one this
 * principal may not see. **All three are the same error on purpose**: a
 * `forbidden` for the third would confirm the id names a real thread somebody
 * else is handling, which is exactly the enumeration TAR-39's security section
 * forbids. RLS already makes the first two indistinguishable; this keeps the
 * third with them.
 */
export class ConversationNotFoundError extends ConversationError {
  constructor(readonly conversationId: string) {
    super('No conversation matches that id.');
  }
}

/**
 * A write into a conversation nobody holds (TAR-186).
 *
 * The shared pool is readable by every agent, which is what makes an arriving
 * customer message reachable at all — and it is exactly why it may not also be
 * writable: two agents looking at the same unclaimed thread would both reply,
 * and the customer would get two answers. `Idempotency-Key` cannot help, because
 * each agent sends a distinct request.
 *
 * Claiming is the fix and the first action: `POST /conversations/{id}/claim`
 * takes the thread out of the pool, and every write then belongs to whoever
 * holds it — one person, or the members of the team it was routed to, who can at
 * least see each other. Closing that narrower case belongs with the routing that
 * creates it (TAR-23/24).
 *
 * `conflict` (409) rather than `forbidden`: the caller may write to this
 * conversation, and what refused them is the state of the row — the same family
 * `whatsapp_window_expired` sits in, and something the caller can act on by
 * claiming. A dedicated code the console could branch on is a contract change
 * to 0002, recorded as a follow-up rather than invented here.
 */
export class ConversationUnclaimedError extends ConversationError {
  constructor(readonly conversationId: string) {
    super('Claim this conversation before replying to it — nobody is holding it yet.');
  }
}

/**
 * A claim that lost the race: the thread was taken between this caller reading
 * it and their claim landing.
 *
 * The colleague who won is deliberately **not** named. The loser has already
 * seen the thread in the shared pool, so the id leaks nothing, but who holds it
 * is the assignment they were about to have taken from them and the console
 * refetches it on the hand-over event (TAR-198) rather than learning it from an
 * error message.
 */
export class ConversationAlreadyClaimedError extends ConversationError {
  constructor(readonly conversationId: string) {
    super('Somebody else claimed this conversation first.');
  }
}

/**
 * The 24-hour customer service window has closed, and the request was not an
 * approved template.
 *
 * Its own code (`whatsapp_window_expired`, 409) rather than a validation
 * failure, because the body was well-formed and what refused it was the state
 * of the conversation. The composer branches on it to switch to the template
 * picker, which is the whole reason the code is published separately.
 */
export class ServiceWindowExpiredError extends ConversationError {
  constructor() {
    super(
      'The 24-hour customer service window for this conversation has closed. Only an approved ' +
        'template may be sent until the customer writes again.',
    );
  }
}

/** Which of the template's preconditions failed, so the caller is told the actionable one. */
export type TemplateRejection = 'not_approved' | 'variables' | 'header' | 'buttons';

/**
 * The named template cannot be sent: it is unknown or unapproved for this
 * number's business account, its positional variables do not match the approved
 * body, or its header slot disagrees with what Meta approved.
 *
 * All three are checked **before** the Cloud API call. Meta answers each of
 * them with an opaque provider error that names a parameter index at best, and
 * an agent cannot act on that — which is the reason 0002 amendment 1 publishes
 * `parameterCount`, `headerFormat` and `headerParameterCount` at all.
 */
export class TemplateNotSendableError extends ConversationError {
  constructor(
    readonly rejection: TemplateRejection,
    message: string,
  ) {
    super(message);
  }

  static notApproved(templateName: string): TemplateNotSendableError {
    return new TemplateNotSendableError(
      'not_approved',
      `No approved template named ${templateName} in that language is available on this number.`,
    );
  }

  static variables(expected: number, received: number): TemplateNotSendableError {
    return new TemplateNotSendableError(
      'variables',
      `That template takes ${expected} variable(s) and ${received} were supplied.`,
    );
  }

  static header(message: string): TemplateNotSendableError {
    return new TemplateNotSendableError('header', message);
  }

  /**
   * The same exclusion `GET /api/v1/message-templates` applies when it drops a
   * row from the picker: a template whose buttons take a send-time parameter
   * cannot be completed by any composer this product builds, because
   * `SendTemplateInput` has no slot for one. Stated as its own rejection so a
   * caller that named such a template — from a stale picker, or by hand — is
   * told what is wrong rather than that the template does not exist.
   */
  static buttons(): TemplateNotSendableError {
    return new TemplateNotSendableError(
      'buttons',
      'That template has buttons that need values at send time, which this API cannot supply yet.',
    );
  }
}

/**
 * The contact has opted out. Blocks every outbound send **including a
 * template** — `ContactResponseSchema.optedOutAt` says so, and honouring an
 * opt-out is a regulatory obligation rather than a preference.
 *
 * Reported as `conflict` (409) by `conversations.http.ts`. The published
 * taxonomy has no `contact_opted_out`, and inventing a code here would make
 * `error-codes.ts` something an implementation edits rather than something 0002
 * rules — so the request conflicting with the resource's state is the honest
 * existing answer, and a dedicated code is recorded as a contract follow-up.
 */
export class ContactOptedOutError extends ConversationError {
  constructor() {
    super('This contact has opted out of messages. Nothing may be sent to them.');
  }
}

/**
 * The `mediaId` in a send names no stored object this tenant owns, or names one
 * whose kind is not the kind the send declared — a `document` sent as an
 * `image`, which Meta would refuse on its own media-type rules.
 *
 * Checked in the request path rather than in the worker so the agent finds out
 * while the composer is still open, instead of watching a message go `queued`
 * and then `failed`.
 */
export class SendMediaNotUsableError extends ConversationError {
  constructor(message: string) {
    super(message);
  }
}

/** A cursor this build cannot act on. The controller turns it into `validation_failed`. */
export class InvalidConversationCursorError extends ConversationError {
  constructor(readonly parameter: string) {
    super('The cursor is not valid. Start from the first page.');
  }
}

/**
 * A request body naming a user or team this tenant does not have — an `assign`
 * addressed to a stranger, or a note mentioning one.
 *
 * `validation_failed` rather than `not_found`: the id is a field of the request
 * body, and the resource the caller addressed — the conversation — was found.
 * `field` is what the error's `details` entry points at, so a form can highlight
 * the offending input rather than showing a banner.
 */
export class UnknownTenantMemberError extends ConversationError {
  constructor(
    readonly field: string,
    readonly kind: 'user' | 'team',
    readonly id: string,
  ) {
    super(`${id} does not name an active ${kind} in this tenant.`);
  }
}

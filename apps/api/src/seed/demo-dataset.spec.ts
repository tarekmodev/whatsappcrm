import { TICKET_EVENT_TYPES } from '@whatsappcrm/contracts';

import {
  DEMO_PLANS,
  DEMO_SLUGS,
  DEMO_SUBSCRIPTION_IDS,
  demoDataset,
  type DemoTenant,
} from './demo-dataset';

/**
 * The demo dataset's internal consistency, without a database.
 *
 * Every assertion here is something PostgreSQL would also catch — a duplicate
 * id, a dangling reference, a second active ticket for one contact. The reason
 * to check it anyway is *when*: `pnpm test` runs with no containers up and gates
 * every pull request, while the seed itself only runs when somebody chooses to
 * run it. Without this file, editing the dataset into a shape the database
 * rejects is a change that merges green and fails on the next developer's clean
 * clone — which is precisely the acceptance criterion TAR-46 exists to protect.
 *
 * It deliberately does **not** re-assert what the types already give (that a
 * `status` is one of the enum's values) or what only the database can answer
 * (that a policy exists). The seed's own read-back pass covers the second.
 */

const NOW = new Date('2026-08-11T12:00:00.000Z');

function everyTenant(): readonly DemoTenant[] {
  return demoDataset(NOW);
}

function idsOf(rows: readonly { id?: string }[]): string[] {
  return rows.map((row) => row.id).filter((id): id is string => id !== undefined);
}

describe('demo dataset', () => {
  const dataset = everyTenant();

  it('is the two tenants the seed and the README both name', () => {
    // The slug is the tenant's identity here, and it is load-bearing twice
    // over: the seed deletes by it, and `PLATFORM_DOMAIN` turns it into the
    // hostname the README tells a developer to open.
    expect(dataset.map((tenant) => tenant.slug)).toEqual([
      DEMO_SLUGS.northwind,
      DEMO_SLUGS.southwind,
    ]);
    expect(Object.keys(DEMO_SUBSCRIPTION_IDS).sort()).toEqual(
      dataset.map((tenant) => tenant.slug).sort(),
    );
  });

  it('uses every id exactly once, across both tenants', () => {
    const all = [
      // Platform-wide, so listed once rather than per tenant.
      ...idsOf(DEMO_PLANS),
    ].concat(
      ...dataset.map((tenant) => [
        ...idsOf([tenant.branding]),
        ...idsOf(tenant.users),
        ...idsOf(tenant.teams),
        ...idsOf(tenant.teamMembers),
        ...idsOf(tenant.businessAccounts),
        ...idsOf(tenant.whatsappAccounts),
        ...idsOf(tenant.messageTemplates),
        ...idsOf(tenant.tags),
        ...idsOf(tenant.customFieldDefs),
        ...idsOf(tenant.contacts),
        ...idsOf(tenant.contactTags),
        ...idsOf(tenant.conversations),
        ...idsOf(tenant.messages),
        ...idsOf(tenant.mediaObjects),
        ...idsOf(tenant.attachments),
        ...idsOf(tenant.internalNotes),
        ...idsOf(tenant.tickets),
        ...idsOf(tenant.ticketEvents),
        ...idsOf(tenant.slaTimers),
        ...idsOf(tenant.slaAlerts),
        ...idsOf(tenant.usageCounters),
        ...idsOf(tenant.auditLogs),
      ]),
    );

    expect(new Set(all).size).toBe(all.length);
  });

  it.each(['northwind', 'southwind'])('%s references only its own rows', (slug) => {
    const tenant = dataset.find((candidate) => candidate.slug === slug);

    if (tenant === undefined) {
      throw new Error(`unreachable: ${slug} is asserted to exist above`);
    }

    const users = new Set(idsOf(tenant.users));
    const teams = new Set(idsOf(tenant.teams));
    const contacts = new Set(idsOf(tenant.contacts));
    const conversations = new Set(idsOf(tenant.conversations));
    const businessAccounts = new Set(idsOf(tenant.businessAccounts));
    const whatsappAccounts = new Set(idsOf(tenant.whatsappAccounts));
    const tickets = new Set(idsOf(tenant.tickets));
    const messages = new Set(idsOf(tenant.messages));
    const mediaObjects = new Set(idsOf(tenant.mediaObjects));
    const tags = new Set(idsOf(tenant.tags));

    // Composite `(tenant_id, <parent_id>)` foreign keys make each of these a
    // write that fails in the database rather than a row pointing sideways —
    // this only moves the failure earlier.
    for (const member of tenant.teamMembers) {
      expect(teams).toContain(member.teamId);
      expect(users).toContain(member.userId);
    }
    for (const account of tenant.whatsappAccounts) {
      expect(businessAccounts).toContain(account.whatsappBusinessAccountId);
    }
    for (const template of tenant.messageTemplates) {
      expect(businessAccounts).toContain(template.whatsappBusinessAccountId);
    }
    for (const contactTag of tenant.contactTags) {
      expect(contacts).toContain(contactTag.contactId);
      expect(tags).toContain(contactTag.tagId);
    }
    for (const conversation of tenant.conversations) {
      expect(whatsappAccounts).toContain(conversation.whatsappAccountId);
      expect(contacts).toContain(conversation.contactId);
      expectOptionalMember(conversation.assignedUserId, users);
      expectOptionalMember(conversation.assignedTeamId, teams);
    }
    for (const message of tenant.messages) {
      expect(conversations).toContain(message.conversationId);
      expectOptionalMember(message.senderUserId, users);
    }
    for (const object of tenant.mediaObjects) {
      expectOptionalMember(object.uploadedByUserId, users);
    }
    for (const attachment of tenant.attachments) {
      expect(messages).toContain(attachment.messageId);
      expectOptionalMember(attachment.mediaObjectId, mediaObjects);
      // The path the inbox fetches is built from the media object's id. A
      // mismatch here is a broken download link that nothing else would catch:
      // both columns are free text as far as the database is concerned.
      if (typeof attachment.mediaObjectId === 'string') {
        expect(attachment.url).toBe(`/api/v1/media/${attachment.mediaObjectId}/content`);
      }
    }
    for (const note of tenant.internalNotes) {
      expect(conversations).toContain(note.conversationId);
      expectOptionalMember(note.authorUserId, users);
      // Prisma widens a scalar-list input to "an array, or a `{ set: [...] }`
      // wrapper". The dataset only ever writes the plain array.
      const mentions = Array.isArray(note.mentionedUserIds) ? note.mentionedUserIds : [];

      for (const mentioned of mentions) {
        expect(users).toContain(mentioned);
      }
    }
    for (const ticket of tenant.tickets) {
      expectOptionalMember(ticket.conversationId, conversations);
      expectOptionalMember(ticket.contactId, contacts);
      expectOptionalMember(ticket.assignedUserId, users);
      expectOptionalMember(ticket.assignedTeamId, teams);
      // Composite foreign keys again, and the same tenant on both sides: a
      // responder or resolver borrowed from the other tenant is a row the
      // database refuses and a per-agent breakdown that names a stranger.
      expectOptionalMember(ticket.firstResponseUserId, users);
      expectOptionalMember(ticket.resolvedByUserId, users);
    }
    for (const event of tenant.ticketEvents) {
      expect(tickets).toContain(event.ticketId);
      expectOptionalMember(event.actorUserId, users);
    }
    for (const log of tenant.auditLogs) {
      expectOptionalMember(log.actorUserId, users);
    }

    const timers = new Set(idsOf(tenant.slaTimers));

    for (const timer of tenant.slaTimers) {
      expect(tickets).toContain(timer.ticketId);
    }
    for (const alert of tenant.slaAlerts) {
      expect(timers).toContain(alert.slaTimerId);
      expect(tickets).toContain(alert.ticketId);
      // The recipient is a real user of *this* tenant. `sla_alerts` is the one
      // table whose rows are written by a job that has just read across every
      // tenant, so a recipient from the other side is the mistake worth naming.
      expect(users).toContain(alert.recipientUserId);
    }
  });

  it('gives each ticket at most one timer per target', () => {
    for (const tenant of dataset) {
      const keys = tenant.slaTimers.map((timer) => `${timer.ticketId}:${timer.kind}`);

      // `UNIQUE (tenant_id, ticket_id, kind)`.
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('states a deadline that agrees with the state the timer is in', () => {
    for (const tenant of dataset) {
      for (const timer of tenant.slaTimers) {
        const startedAt = at(timer.startedAt);
        const dueAt = at(timer.dueAt);

        // The seeded policy is a 60-minute first-response window, and `due_at`
        // is authoritative rather than derived at read time — so a timer that
        // does not sit one window past its start is demonstrating a pause that
        // the dataset does not otherwise carry.
        expect(dueAt - startedAt).toBe(60 * 60 * 1000);

        if (timer.state === 'breached') {
          // Detection is a sweep, not an interrupt, so `breached_at` is at or
          // after the deadline — never before it, which would be a false breach.
          expect(at(timer.breachedAt)).toBeGreaterThanOrEqual(dueAt);
          // `breached` is terminal and does not stop the clock the way a reply
          // does; `stopped_at` is for `met` and `cancelled`.
          expect(timer.stoppedAt ?? null).toBeNull();
        }

        if (timer.state === 'met') {
          // Met means the reply landed strictly inside the window. Exactly on
          // the deadline is a race between the reply and the sweep, and a
          // seeded row must not be ambiguous about which it is.
          expect(at(timer.stoppedAt)).toBeLessThan(dueAt);
          expect(timer.breachedAt ?? null).toBeNull();
        }
      }
    }
  });

  it('raises an alert for exactly the timers that breached', () => {
    for (const tenant of dataset) {
      const breached = new Set(
        tenant.slaTimers.filter((timer) => timer.state === 'breached').map((timer) => timer.id),
      );
      const alerted = new Set(tenant.slaAlerts.map((alert) => alert.slaTimerId));

      // Both directions. An alert on a timer that did not breach is a false
      // alarm; a breached timer with no alert is the supervisor never being
      // told, which is TAR-26's whole acceptance criterion.
      expect([...alerted].sort()).toEqual([...breached].sort());

      for (const alert of tenant.slaAlerts) {
        const timer = tenant.slaTimers.find((candidate) => candidate.id === alert.slaTimerId);

        // The deadline is copied onto the alert at write time so a later policy
        // edit cannot rewrite history. Copied means equal, here and now.
        expect(at(alert.dueAt)).toBe(at(timer?.dueAt));
        expect(alert.kind).toBe(timer?.kind);
      }

      // One row per recipient per timer — `UNIQUE (tenant_id, sla_timer_id,
      // recipient_user_id)`, the second of the three idempotency layers.
      const keys = tenant.slaAlerts.map((alert) => `${alert.slaTimerId}:${alert.recipientUserId}`);

      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('holds at most one open or pending ticket per contact', () => {
    for (const tenant of dataset) {
      const active = tenant.tickets
        .filter((ticket) => ticket.status === 'open' || ticket.status === 'pending')
        .map((ticket) => ticket.contactId)
        .filter((contactId): contactId is string => typeof contactId === 'string');

      // `tickets_one_active_per_contact` is a partial unique index, and Prisma's
      // describer skips it — so a second active ticket for one contact is a seed
      // that fails on insert with no schema-level warning first.
      expect(new Set(active).size).toBe(active.length);
    }
  });

  it('names the person behind every seeded first response and resolution', () => {
    for (const tenant of dataset) {
      for (const ticket of tenant.tickets) {
        // Both halves or neither, in both directions. A timestamp with no actor
        // is what TAR-492 was: the reporting query reads
        // `first_response_user_id` / `resolved_by_user_id` and nothing else, so
        // the work still counts in the summary cards while every named agent
        // shows zero and the whole of it lands in the `unattributed` row — a
        // dashboard that says nobody did the work it is simultaneously
        // reporting. An actor with no timestamp is the mirror defect: a person
        // credited for an event the dataset never says happened.
        expect((ticket.firstResponseUserId ?? null) === null).toBe(
          (ticket.firstRespondedAt ?? null) === null,
        );
        expect((ticket.resolvedByUserId ?? null) === null).toBe(
          (ticket.resolvedAt ?? null) === null,
        );

        if ((ticket.firstRespondedAt ?? null) === null) {
          continue;
        }

        // And the actor is the one the rest of the dataset already implies.
        // `first_response_at` is stamped in the same transaction as the outbound
        // message that earned it, so the seeded thread has to agree about who
        // sent that message — otherwise the timeline and the breakdown tell a
        // supervisor two different stories about the same reply.
        const reply = tenant.messages.find(
          (message) =>
            message.conversationId === ticket.conversationId &&
            message.direction === 'outbound' &&
            at(message.sentAt) === at(ticket.firstRespondedAt),
        );

        expect(reply).toBeDefined();
        expect(reply?.senderUserId).toBe(ticket.firstResponseUserId);
      }
    }
  });

  it('records ticket events with types the contract knows', () => {
    for (const tenant of dataset) {
      for (const event of tenant.ticketEvents) {
        // `ticket_events.type` is a text column, not an enum, so the database
        // takes anything. TAR-73's timeline endpoint validates its response
        // against this list, and a seeded event outside it fails there — on the
        // next developer's clean clone, long after the seed merged green.
        expect(TICKET_EVENT_TYPES).toContain(event.type);
      }
    }
  });

  it('leaves the ticket counter one past the highest seeded number', () => {
    for (const tenant of dataset) {
      const highest = tenant.tickets.reduce((max, ticket) => Math.max(max, ticket.number), 0);

      // Null only when there are no tickets: TAR-73 creates the row lazily.
      expect(tenant.nextTicketNumber).toBe(tenant.tickets.length === 0 ? null : highest + 1);
    }
  });

  it('opens one thread per contact per WhatsApp number', () => {
    for (const tenant of dataset) {
      const keys = tenant.conversations.map(
        (conversation) => `${conversation.whatsappAccountId}:${conversation.contactId}`,
      );

      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('agrees with itself about when each conversation last spoke', () => {
    for (const tenant of dataset) {
      for (const conversation of tenant.conversations) {
        const sent = tenant.messages
          .filter((message) => message.conversationId === conversation.id)
          .map((message) => new Date(message.sentAt).getTime());

        // `last_message_at` is denormalised from `messages` and is the leading
        // sort key of all three inbox indexes. A value that disagrees with the
        // thread puts a conversation on the wrong page of the inbox, which reads
        // as a pagination bug rather than as bad data.
        expect(sent.length).toBeGreaterThan(0);
        expect(new Date(conversation.lastMessageAt as string | Date).getTime()).toBe(
          Math.max(...sent),
        );
      }
    }
  });

  it('never claims more unread messages than the thread has inbound ones', () => {
    for (const tenant of dataset) {
      for (const conversation of tenant.conversations) {
        const inbound = tenant.messages.filter(
          (message) =>
            message.conversationId === conversation.id && message.direction === 'inbound',
        ).length;

        // Deliberately a bound rather than an equality: whether an agent has
        // already opened an inbound message is state this dataset chooses per
        // thread, and both answers are legitimate. What is never legitimate is
        // an unread badge counting messages that do not exist — the shape the
        // console's fixtures happened to have, and the one that makes a reviewer
        // distrust every other number on the page.
        expect(conversation.unreadCount ?? 0).toBeGreaterThanOrEqual(0);
        expect(conversation.unreadCount ?? 0).toBeLessThanOrEqual(inbound);
      }
    }
  });

  it('gives every plan a distinct key and a whole number of minor units', () => {
    const keys = DEMO_PLANS.map((plan) => plan.key);

    expect(new Set(keys).size).toBe(keys.length);

    for (const plan of DEMO_PLANS) {
      expect(Number.isInteger(plan.priceMinorUnits)).toBe(true);
      expect(plan.currency).toHaveLength(3);
    }
  });

  it('subscribes each tenant to a plan the catalogue actually has', () => {
    const keys = new Set(DEMO_PLANS.map((plan) => plan.key));

    for (const tenant of dataset) {
      expect(keys).toContain(tenant.subscription.planKey);
    }
  });

  it('bills only for the users who occupy a seat', () => {
    for (const tenant of dataset) {
      // `occupiesSeat` in `people.mapper.ts`: active or suspended, never invited
      // or removed. The seeded counter has to match, or the first thing anyone
      // checks about billing is wrong on a fresh database.
      const occupying = tenant.users.filter(
        (user) => user.status === 'active' || user.status === 'suspended',
      ).length;
      const seatCounter = tenant.usageCounters.find((counter) => counter.metric === 'seats');

      expect(seatCounter?.value).toBe(BigInt(occupying));
    }
  });
});

function expectOptionalMember(
  value: string | null | undefined,
  allowed: ReadonlySet<string>,
): void {
  if (value !== null && value !== undefined) {
    expect(allowed).toContain(value);
  }
}

/**
 * A timestamp as milliseconds. Prisma widens every date input to `Date | string`
 * and makes the ones with a column default optional; the dataset only ever
 * writes a `Date`, and a missing one is a defect rather than a case to handle,
 * so this throws instead of returning a sentinel that comparisons would silently
 * pass.
 */
function at(value: Date | string | null | undefined): number {
  if (value === null || value === undefined) {
    throw new Error('expected a timestamp, and the dataset supplied none');
  }

  return new Date(value).getTime();
}

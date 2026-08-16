import { SectionCard } from '@/components/ui/SectionCard';
import { Stack } from '@/components/layout/Stack';
import { content } from '@/content/en';
import { verifySession } from '@/lib/session/session';
import { loadTicketDetail } from '@/features/tickets/tickets.data';
import { loadHandoffCandidates } from '@/features/tickets/ticket-handoff.data';
import { ticketLabel } from '@/features/tickets/presentation';
import { TicketControls, TicketControlsSkeleton } from './TicketControls';
import { TicketHandoffControls, TicketHandoffControlsSkeleton } from './TicketHandoffControls';
import { TicketSummary, TicketSummarySkeleton } from './TicketSummary';
import { TicketUnavailable } from './TicketUnavailable';

/**
 * Fetches one ticket and composes the two cards it renders as. Usage: inside a
 * Suspense boundary on the ticket page, keyed on the id, with
 * `TicketDetailSectionSkeleton` as the fallback.
 *
 * The session read is request-cached, so the permission check costs no round
 * trip on top of the page's own.
 */
export async function TicketDetailSection({ ticketId }: { ticketId: string }) {
  const [session, result] = await Promise.all([verifySession(), loadTicketDetail(ticketId)]);

  if (result.outcome === 'unavailable') {
    return <TicketUnavailable />;
  }

  const { ticket, conversation, userNames, teamNames } = result.detail;
  const label = ticketLabel(ticket);
  const canReassign = session.checker.can('ticket:handoff');
  const canEscalate = session.checker.can('ticket:escalate');

  // Only when there is a picker to fill. A principal holding neither permission
  // sees the card's explanation instead, and paying for a user list to render it
  // would be a round trip for a notice.
  const candidates =
    canReassign || canEscalate
      ? await loadHandoffCandidates(session.principal, ticket)
      : { teammates: [], supervisors: [] };

  return (
    <Stack gap="4">
      <SectionCard id="ticket" title={label}>
        <TicketSummary
          ticket={ticket}
          conversation={conversation}
          userNames={userNames}
          teamNames={teamNames}
        />
      </SectionCard>

      <SectionCard id="ticket-controls" title={content.tickets.controlsHeading}>
        <TicketControls
          ticketId={ticket.id}
          label={label}
          status={ticket.status}
          priority={ticket.priority}
          canUpdate={session.checker.can('ticket:update')}
          canClose={session.checker.can('ticket:close')}
        />
      </SectionCard>

      <SectionCard id="ticket-handoff" title={content.tickets.handoffHeading}>
        <TicketHandoffControls
          ticketId={ticket.id}
          label={label}
          teammates={candidates.teammates}
          supervisors={candidates.supervisors}
          canReassign={canReassign}
          canEscalate={canEscalate}
        />
      </SectionCard>
    </Stack>
  );
}

/**
 * Mirrors `TicketDetailSection`: the same two cards in the same order, each
 * holding its own component's skeleton, so the swap to a real ticket moves
 * nothing.
 *
 * The first card's heading reads "Ticket" rather than the subject, which is the
 * one thing here that genuinely is not known yet: `SectionCard` takes a string,
 * and both headings are a single line, so the swap changes the words without
 * moving anything below them.
 */
export function TicketDetailSectionSkeleton() {
  return (
    <Stack gap="4">
      <SectionCard id="ticket" title={content.tickets.detailHeading}>
        <TicketSummarySkeleton />
      </SectionCard>

      <SectionCard id="ticket-controls" title={content.tickets.controlsHeading}>
        <TicketControlsSkeleton />
      </SectionCard>

      <SectionCard id="ticket-handoff" title={content.tickets.handoffHeading}>
        <TicketHandoffControlsSkeleton />
      </SectionCard>
    </Stack>
  );
}

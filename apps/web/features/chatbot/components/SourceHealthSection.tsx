import { hasAnySources, loadSourceHealth } from '../chatbot.data';
import type { KnowledgeListParams } from '../knowledge-params';
import { SourceHealthStrip } from './SourceHealthStrip';

/**
 * Reads the three source counts and draws the strip — or draws nothing.
 *
 * **Nothing, when the tenant has no sources at all.** The table's empty state
 * below is the whole story then, and three tiles reading zero above it are
 * furniture that pushes the one sentence that matters further down the card.
 *
 * Its own boundary, and its own component, so the counts do not hold up the
 * filter row or the table: the strip is a summary of the same knowledge base
 * those two are already showing, and a slow status scan must not delay the rows
 * themselves.
 */
export async function SourceHealthSection({ filters }: { filters: KnowledgeListParams }) {
  const health = await loadSourceHealth();

  return hasAnySources(health) ? <SourceHealthStrip health={health} filters={filters} /> : null;
}

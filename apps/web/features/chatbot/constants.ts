import type { Permission } from '@whatsappcrm/contracts';

/**
 * The permissions this surface’s controls are gated on, named once.
 *
 * Here rather than beside one of the sections, because three components now
 * read them: the settings form, the knowledge base’s `Add entry` gate and the
 * page’s own route guard, each in a different boundary.
 */
export const CHATBOT_PERMISSIONS = {
  read: 'ai:read',
  write: 'ai:write',
} as const satisfies Record<string, Permission>;

/**
 * How many knowledge base entries one page of the table holds.
 *
 * The table's skeleton draws exactly this many rows, so the swap from loading to
 * loaded does not change the card's height. Ten rather than the contract's
 * default 25: a tenant's knowledge base is an FAQ and a policy set — tens of
 * documents, not thousands — and a ten-row skeleton reserves a box somebody can
 * see the bottom of.
 */
export const KNOWLEDGE_DOCUMENTS_PAGE_SIZE = 10;

/**
 * How many rows the table’s skeleton draws while a *filtered* read is in
 * flight (TAR-613).
 *
 * Three rather than the page size. A narrowed search usually returns one or
 * two entries, and ten skeleton rows collapsing to one is a bigger jolt than a
 * short placeholder growing. The unfiltered first load keeps the page size,
 * where ten rows is what actually arrives.
 */
export const KNOWLEDGE_FILTERED_SKELETON_ROWS = 3;

/**
 * The cap the search box puts on a title fragment, mirroring
 * `KnowledgeDocumentListQuerySchema.q` (`z.string().min(1).max(120)`).
 *
 * Named here rather than typed into the control, so the box cannot offer a
 * term the parser behind the URL would silently drop — which from the reader’s
 * side is a search box that stops working with no explanation.
 */
export const KNOWLEDGE_QUERY_MAX_LENGTH = 120;

/**
 * How tall the entry editor's text area is, in rows.
 *
 * Shared with its skeleton rather than typed into both: the blank lines that
 * become chunk boundaries have to be visible while the entry is being written,
 * and a placeholder of a different height would move the dialog under the
 * cursor when the real field arrives.
 */
export const ENTRY_CONTENT_ROWS = 10;

/**
 * The bounds and the granularity of the confidence slider.
 *
 * The range mirrors `AiConfigResponseSchema.minConfidence`, which is
 * `z.number().min(0).max(1)` — named here rather than typed into the control so
 * the slider cannot offer a value the schema refuses.
 *
 * The step is the console's alone: nothing on the server cares whether a
 * threshold is 0.60 or 0.6173, but an admin reading "62%" back cannot tell
 * whether somebody chose it or a drag produced it. Five points is the coarsest
 * granularity that still lets the threshold be tuned.
 */
/**
 * How often the chatbot page refetches while an entry is still indexing.
 *
 * Indexing is seconds of work, so four is short enough that a `Indexing` badge
 * turns into `Ready` while somebody is still looking at it, and long enough that
 * a knowledge base with a stuck entry is not refetching the whole page many
 * times a minute. See `useIndexingRefresh`, which only runs while something is
 * pending and skips a tick in a hidden tab.
 */
export const INDEXING_REFRESH_INTERVAL_MS = 4_000;

export const MIN_CONFIDENCE_RANGE = {
  min: 0,
  max: 1,
  step: 0.05,
} as const;

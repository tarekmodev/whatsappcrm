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

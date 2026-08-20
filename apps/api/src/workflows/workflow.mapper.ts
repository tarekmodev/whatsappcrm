import {
  WorkflowActionResultSchema,
  WorkflowDefinitionSchema,
  workflowReferenceUses,
  type WorkflowActionResult,
  type WorkflowDefinition,
  type WorkflowReference,
  type WorkflowTaxonomyKind,
  type WorkflowResponse,
  type WorkflowRunResponse,
} from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { MalformedWorkflowDefinitionError } from './workflows.errors';

/**
 * `workflows` → `WorkflowResponse`, and `workflow_runs` → `WorkflowRunResponse`.
 *
 * ## The projection is the response, and nothing else
 *
 * One constant per resource rather than a `select` per call site, for the reason
 * `ticket.mapper.ts` states: the list, the detail read and the write that
 * returns the resource all load exactly the columns the response publishes.
 * Three copies is how one of them quietly grows a `SELECT *` — and `definition`
 * is a JSONB column that a wide read would carry for every row of every list.
 *
 * ## `references` is joined at read time and never stored
 *
 * This is TAR-27's second acceptance criterion, and it is the whole reason the
 * definition stores ids and only ids (0009, decision 6). A rename therefore
 * requires nothing at all — no migration, no backfill, no cache bust — because
 * the name reaching the console is read now rather than copied then. A response
 * that embedded a stored name would show the old one **and look healthy**, which
 * is precisely the silent breakage the criterion is written against.
 *
 * `exists: false` is the visible half: a reference whose row is gone comes back
 * named `null` and marked absent, so the console renders a broken rule without a
 * second request.
 */

export const WORKFLOW_PROJECTION = {
  id: true,
  name: true,
  position: true,
  isActive: true,
  brokenReason: true,
  triggerType: true,
  definition: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.WorkflowSelect;

export type WorkflowRow = Prisma.WorkflowGetPayload<{ select: typeof WORKFLOW_PROJECTION }>;

export const WORKFLOW_RUN_PROJECTION = {
  id: true,
  workflowId: true,
  workflowVersion: true,
  ticketId: true,
  status: true,
  results: true,
  failureReason: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  ticket: { select: { number: true } },
  workflow: { select: { triggerType: true } },
} as const satisfies Prisma.WorkflowRunSelect;

export type WorkflowRunRow = Prisma.WorkflowRunGetPayload<{
  select: typeof WORKFLOW_RUN_PROJECTION;
}>;

/**
 * The names every reference in a set of workflows resolves to, or absence.
 *
 * One map rather than a lookup per reference: a list of 50 workflows would
 * otherwise issue one query per tag, per team and per user each of them names.
 * `WorkflowService.resolveReferences` fills it with three `IN` queries for the
 * whole page.
 */
export type ReferenceNames = ReadonlyMap<string, string>;

/** `tag:019f…` — the key both the resolver and the mapper build. */
export function referenceKey(kind: WorkflowTaxonomyKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Parses `workflows.definition` back into the published grammar.
 *
 * Read as well as written through the schema, deliberately. The API is the only
 * writer and validates on the way in, so a row that fails here took a hand edit
 * or a grammar change that removed a member — and in either case a named failure
 * is what a supervisor can act on, where a silent partial parse is not.
 *
 * `triggerType` is a column duplicating `definition.trigger.type` (0009's data
 * model says so, and says why: a JSONB extraction cannot use the composite index
 * the evaluation query needs). The service writes both in one statement; the
 * check below is what makes a divergence a failure rather than a workflow that
 * is indexed under one trigger and behaves as another.
 */
export function readDefinition(row: {
  id: string;
  definition: Prisma.JsonValue;
  triggerType: string;
}): WorkflowDefinition {
  const parsed = WorkflowDefinitionSchema.safeParse(row.definition);

  if (!parsed.success) {
    throw new MalformedWorkflowDefinitionError(row.id, parsed.error.message);
  }

  if (parsed.data.trigger.type !== row.triggerType) {
    throw new MalformedWorkflowDefinitionError(
      row.id,
      `trigger_type is ${row.triggerType} but the definition says ${parsed.data.trigger.type}`,
    );
  }

  return parsed.data;
}

/**
 * `workflow_runs.results` back into the published array.
 *
 * `workflow_runs_results_is_array` makes the column an array in the database, so
 * the only way an entry fails here is a writer that shipped a shape the response
 * does not publish. Dropped rather than thrown on: a run row is a *log*, and
 * refusing to show a supervisor the whole run list because one historical entry
 * has an unexpected key would hide the ninety-nine that are fine.
 */
export function readActionResults(results: Prisma.JsonValue): WorkflowActionResult[] {
  if (!Array.isArray(results)) {
    return [];
  }

  return results.flatMap((entry) => {
    const parsed = WorkflowActionResultSchema.safeParse(entry);

    return parsed.success ? [parsed.data] : [];
  });
}

export function toWorkflowResponse(row: WorkflowRow, names: ReferenceNames): WorkflowResponse {
  const definition = readDefinition(row);

  return {
    id: row.id,
    name: row.name,
    position: row.position,
    isActive: row.isActive,
    brokenReason: row.brokenReason,
    version: row.version,
    trigger: definition.trigger,
    conditions: definition.conditions,
    actions: definition.actions,
    references: toReferences(definition, names),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * One entry per distinct entity the definition names, in the order it is first
 * named — so the console can walk the rule top to bottom and find each broken
 * reference where it appears.
 *
 * De-duplicated: a workflow that tags with `escalated` and also conditions on it
 * publishes one reference, matching `workflow_references`' own
 * "one row per (workflow, entity)" rule.
 */
export function toReferences(
  definition: WorkflowDefinition,
  names: ReferenceNames,
): WorkflowReference[] {
  const seen = new Set<string>();
  const references: WorkflowReference[] = [];

  for (const use of workflowReferenceUses(definition.conditions, definition.actions)) {
    const key = referenceKey(use.kind, use.id);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    const name = names.get(key);

    references.push({
      kind: use.kind,
      id: use.id,
      // Null exactly when `exists` is false — the two fields are one fact, and
      // the schema says so.
      name: name ?? null,
      exists: name !== undefined,
    });
  }

  return references;
}

export function toWorkflowRunResponse(row: WorkflowRunRow): WorkflowRunResponse {
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowVersion: row.workflowVersion,
    ticketId: row.ticketId,
    ticketNumber: row.ticket.number,
    status: row.status,
    triggerType: row.workflow.triggerType,
    results: readActionResults(row.results),
    failureReason: row.failureReason,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

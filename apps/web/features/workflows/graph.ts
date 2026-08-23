import {
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_CONDITION_TYPES,
  workflowReferenceUses,
  type WorkflowAction,
  type WorkflowActionOutcome,
  type WorkflowActionType,
  type WorkflowCondition,
  type WorkflowConditionType,
  type WorkflowReference,
  type WorkflowTestResponse,
  type WorkflowTrigger,
} from '@whatsappcrm/contracts';
import type { Content } from '@/lib/content';
import { blankAction, blankCondition } from './builder';
import {
  createReferenceLookup,
  describeAction,
  describeCondition,
  describeTrigger,
  type WorkflowVocabulary,
} from './presentation';
import type { WorkflowDraft, WorkflowDraftErrors } from './workflow-form';

/**
 * The workflow canvas's projection layer — TAR-809's Phase A, implemented.
 *
 * **The draft is the state; the graph is a picture of it.** `toGraph` is a total,
 * deterministic function of a `WorkflowDraft` plus its annotations, and every
 * mutation here takes a draft and returns a draft. Nothing edits a graph. That
 * is what makes the canvas impossible to desynchronise from what will be saved:
 * there is one source of truth and the other thing is recomputed.
 *
 * **This module knows nothing about `@xyflow/react`.** No import, no type. The
 * renderer adapts `WorkflowGraphNode` to that library's `Node`; it does not
 * replace it. TAR-809 requires the containment (the library is imported only
 * from `workflow-canvas.lazy.tsx`) and it starts here.
 *
 * ## Node identity is positional
 *
 * `condition:2` **is** `draft.conditions[2]`. No generated id, no reconciliation
 * table. Deleting `condition:1` renumbers everything below it, which is correct
 * rather than merely tolerable: the API's error paths (`conditions.2.tagIds`),
 * its dry-run results (`{ index: 2 }`) and `validateWorkflowDraft`'s
 * `byCondition` / `byAction` keys are all positional too, so every annotation in
 * `toGraph` lands on its node by construction. A generated id would need a
 * translation table to buy back exactly what positional identity gives free.
 *
 * ## The grammar is a chain, so layout is arithmetic
 *
 * ADR 0009 gives one trigger, conditions that all must hold, and an ordered
 * action list — no branch, no OR, nothing to route. `layoutSpine` is therefore
 * the whole layout engine, and TAR-809 rejected `dagre`/`elkjs` on exactly that
 * ground. Coordinates are derived on every render and never persisted (TAR-809
 * decision 3), so free node placement is deliberately not a feature: a dragged
 * action snaps back to its computed slot with the array reordered underneath.
 *
 * ## What it deliberately does not check
 *
 * Whether a condition or action is *complete*. That is `validateWorkflowDraft`'s,
 * and stating it twice is how two readings of one rule drift apart. This module
 * *carries* those messages onto nodes; it never re-derives them.
 */

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export const WORKFLOW_NODE_KINDS = ['trigger', 'condition', 'action'] as const;

export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

/**
 * `trigger`, or a kind and an index into the draft's matching array.
 *
 * A template-literal type rather than a bare `string`, so a caller cannot invent
 * `condition-2` or `action:first` and discover it at runtime.
 */
export type WorkflowNodeId = 'trigger' | `condition:${number}` | `action:${number}`;

/** The trigger's node id, named so no caller writes the literal. */
export const TRIGGER_NODE_ID = 'trigger';

/**
 * A point in the canvas's own coordinate space.
 *
 * Declared here rather than imported from the renderer: it is two numbers, and
 * importing `XYPosition` from `@xyflow/react` would put the library in this
 * module's import graph for nothing — the containment TAR-809 asks for is only
 * as good as its least interesting import.
 */
export interface XYPosition {
  readonly x: number;
  readonly y: number;
}

/** What a dry run said about one node. */
export type NodeTestResult =
  | { readonly kind: 'condition'; readonly held: boolean; readonly reason: string | null }
  | {
      readonly kind: 'action';
      readonly outcome: WorkflowActionOutcome;
      /** The server's resolved sentence: `Reassign to team "Escalations"`. */
      readonly describes: string;
    };

export interface WorkflowGraphNode {
  readonly id: WorkflowNodeId;
  readonly kind: WorkflowNodeKind;
  /** Index into `draft.conditions` / `draft.actions`; null for the trigger. */
  readonly index: number | null;
  readonly position: XYPosition;
  /** One-line summary, from `presentation.ts`. */
  readonly summary: string;
  /** Draft-validation message for this node, from `WorkflowDraftErrors`. */
  readonly error: string | null;
  /** Taxonomy ids this node names that no longer resolve. */
  readonly brokenReferences: readonly WorkflowReference[];
  /** Dry-run outcome, when a test has been run against this draft. */
  readonly testResult: NodeTestResult | null;
}

export interface WorkflowGraphEdge {
  readonly id: string;
  readonly source: WorkflowNodeId;
  readonly target: WorkflowNodeId;
}

export interface WorkflowGraph {
  readonly nodes: readonly WorkflowGraphNode[];
  readonly edges: readonly WorkflowGraphEdge[];
}

/**
 * Everything `toGraph` overlays on the spine beyond the draft itself.
 *
 * TAR-809 lists `errors`, `references` and `test`. `vocabulary` and `content` are
 * here because the summaries come from `presentation.ts`, whose `describe*`
 * functions take a `ReferenceLookup` and a `Content` — the spec says the summary
 * comes from there without restating their arguments. Nothing else is added.
 */
export interface WorkflowGraphAnnotations {
  readonly errors: WorkflowDraftErrors;
  /** `WorkflowResponse.references`; empty for a workflow that has never been saved. */
  readonly references: readonly WorkflowReference[];
  readonly test: WorkflowTestResponse | null;
  readonly vocabulary: WorkflowVocabulary;
  readonly content: Content;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Node box and spacing, in canvas units. The only geometry this module owns. */
export const NODE_WIDTH = 320;
export const NODE_HEIGHT = 88;
export const NODE_GAP = 40;

const NODE_PITCH = NODE_HEIGHT + NODE_GAP;

/**
 * One column, top to bottom.
 *
 * Vertical rather than horizontal on TAR-809 decision 4: React Flow's viewport
 * transform is not `dir`-aware, so a left-to-right spine would need its edge
 * geometry mirrored for TAR-806's Arabic pass. "The next step is below" means
 * the same thing in both directions.
 */
export function layoutSpine(nodeCount: number): readonly XYPosition[] {
  return Array.from({ length: Math.max(nodeCount, 0) }, (_, index) => ({
    x: 0,
    y: index * NODE_PITCH,
  }));
}

/**
 * Where a dropped action lands, as an index into `draft.actions`.
 *
 * `y` is the dragged node's top edge in the same space `layoutSpine` produces,
 * measured **from the first action's slot** — the caller subtracts the action
 * band's origin, because only the canvas knows how many condition nodes sit
 * above it. Rounding rather than flooring so a node dragged more than half a
 * slot moves, which is what the gesture looks like it should do.
 */
export function dropIndex(y: number, actionCount: number): number {
  if (actionCount <= 0) {
    return 0;
  }

  return clamp(Math.round(y / NODE_PITCH), 0, actionCount - 1);
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * The draft, as a spine with every annotation already on the right node.
 *
 * Total and deterministic: no `Date.now()`, no `Math.random()`, no id counter, so
 * the server and the client build the same graph and the canvas can render
 * before it mounts.
 */
export function toGraph(
  draft: WorkflowDraft,
  annotations: WorkflowGraphAnnotations,
): WorkflowGraph {
  const { errors, references, test, vocabulary, content } = annotations;
  const names = createReferenceLookup(references, vocabulary);
  const broken = brokenReferencesByNode(draft, references);
  const positions = layoutSpine(1 + draft.conditions.length + draft.actions.length);

  const nodes: WorkflowGraphNode[] = [
    {
      id: TRIGGER_NODE_ID,
      kind: 'trigger',
      index: null,
      position: positionAt(positions, 0),
      summary: describeTrigger(draft.trigger, content),
      error: errors.trigger ?? null,
      brokenReferences: broken.get(TRIGGER_NODE_ID) ?? [],
      testResult: null,
    },
  ];

  draft.conditions.forEach((condition, index) => {
    const id = conditionNodeId(index);

    nodes.push({
      id,
      kind: 'condition',
      index,
      position: positionAt(positions, nodes.length),
      summary: describeCondition(condition, names, content),
      error: errors.byCondition[index] ?? null,
      brokenReferences: broken.get(id) ?? [],
      testResult: conditionTestResult(test, index),
    });
  });

  draft.actions.forEach((action, index) => {
    const id = actionNodeId(index);

    nodes.push({
      id,
      kind: 'action',
      index,
      position: positionAt(positions, nodes.length),
      summary: describeAction(action, names, content),
      error: errors.byAction[index] ?? null,
      brokenReferences: broken.get(id) ?? [],
      testResult: actionTestResult(test, index),
    });
  });

  return { nodes, edges: chainEdges(nodes) };
}

/**
 * The broken references each node names, keyed by node id.
 *
 * `workflowReferenceUses` is the contract's own map from a definition to the
 * paths that name a taxonomy id, and `nodeIdForPath` is the same parser the
 * server's refusal path uses — so a badge on a node and a `PATCH` refusal
 * highlighting that node cannot disagree about which node it is.
 */
function brokenReferencesByNode(
  draft: WorkflowDraft,
  references: readonly WorkflowReference[],
): ReadonlyMap<WorkflowNodeId, readonly WorkflowReference[]> {
  const missing = new Map(
    references
      .filter((reference) => !reference.exists)
      .map((reference) => [`${reference.kind}:${reference.id}`, reference]),
  );

  if (missing.size === 0) {
    return new Map();
  }

  const byNode = new Map<WorkflowNodeId, WorkflowReference[]>();

  for (const use of workflowReferenceUses(draft.conditions, draft.actions)) {
    const reference = missing.get(`${use.kind}:${use.id}`);
    const id = reference === undefined ? null : nodeIdForPath(use.path);

    if (reference === undefined || id === null) {
      continue;
    }

    const existing = byNode.get(id);

    // One node can name two missing ids — a tag condition listing two removed
    // tags — and the badge counts them, so they accumulate rather than replace.
    if (existing === undefined) {
      byNode.set(id, [reference]);
    } else if (!existing.includes(reference)) {
      existing.push(reference);
    }
  }

  return byNode;
}

function conditionTestResult(
  test: WorkflowTestResponse | null,
  index: number,
): NodeTestResult | null {
  const result = test?.conditions.find((candidate) => candidate.index === index);

  return result === undefined
    ? null
    : { kind: 'condition', held: result.held, reason: result.reason };
}

function actionTestResult(test: WorkflowTestResponse | null, index: number): NodeTestResult | null {
  const result = test?.actions.find((candidate) => candidate.index === index);

  return result === undefined
    ? null
    : { kind: 'action', outcome: result.outcome, describes: result.describes };
}

// ---------------------------------------------------------------------------
// Mutations — each takes a draft and returns a draft
// ---------------------------------------------------------------------------

/**
 * Appends a blank condition of `type`.
 *
 * The blank shape comes from `builder.ts`, which already owns it and already
 * tests it. A second set of defaults here would be the same rule written twice.
 */
export function addCondition(draft: WorkflowDraft, type: WorkflowConditionType): WorkflowDraft {
  return { ...draft, conditions: [...draft.conditions, blankCondition(type)] };
}

/** Appends a blank action of `type`, from `builder.ts`'s shapes. */
export function addAction(
  draft: WorkflowDraft,
  type: WorkflowActionType,
  vocabulary: WorkflowVocabulary,
): WorkflowDraft {
  return { ...draft, actions: [...draft.actions, blankAction(type, vocabulary)] };
}

/**
 * Removes the condition or action a node stands for.
 *
 * The trigger cannot be removed — every workflow has exactly one — and an index
 * that is out of range is a no-op rather than an error, so a double-click on
 * delete after the array already shrank does nothing instead of throwing.
 */
export function removeNode(draft: WorkflowDraft, id: WorkflowNodeId): WorkflowDraft {
  const parsed = parseNodeId(id);

  if (parsed === null || parsed.kind === 'trigger') {
    return draft;
  }

  if (parsed.kind === 'condition') {
    return parsed.index >= draft.conditions.length
      ? draft
      : { ...draft, conditions: withoutIndex(draft.conditions, parsed.index) };
  }

  return parsed.index >= draft.actions.length
    ? draft
    : { ...draft, actions: withoutIndex(draft.actions, parsed.index) };
}

/**
 * Replaces what a node holds.
 *
 * `value`'s kind has to match the node's, and it is checked rather than trusted:
 * the three `type` vocabularies are disjoint, so a trigger handed to a condition
 * node is detectable here instead of at the API's refusal. A mismatch — or an
 * index past the end — returns the draft **unchanged**, the same no-op
 * `removeNode` gives, so a detail panel holding a stale id cannot half-apply an
 * edit.
 */
export function replaceNode(
  draft: WorkflowDraft,
  id: WorkflowNodeId,
  value: WorkflowTrigger | WorkflowCondition | WorkflowAction,
): WorkflowDraft {
  const parsed = parseNodeId(id);

  if (parsed === null) {
    return draft;
  }

  if (parsed.kind === 'trigger') {
    return isTrigger(value) ? { ...draft, trigger: value } : draft;
  }

  if (parsed.kind === 'condition') {
    return isCondition(value) && parsed.index < draft.conditions.length
      ? { ...draft, conditions: withIndex(draft.conditions, parsed.index, value) }
      : draft;
  }

  return isAction(value) && parsed.index < draft.actions.length
    ? { ...draft, actions: withIndex(draft.actions, parsed.index, value) }
    : draft;
}

/**
 * Reorders the action list. Drag-to-reorder and the keyboard move controls both
 * land here, so there is one implementation of "what a move means".
 *
 * Action order is execution order (0009), which is why this exists for actions
 * and not for conditions: reordering an AND changes nothing a supervisor could
 * observe, so offering the gesture would only invite a pointless diff.
 */
export function moveAction(draft: WorkflowDraft, from: number, to: number): WorkflowDraft {
  const count = draft.actions.length;

  if (from < 0 || from >= count) {
    return draft;
  }

  const target = clamp(to, 0, count - 1);

  if (from === target) {
    return draft;
  }

  const moved = draft.actions[from];

  if (moved === undefined) {
    return draft;
  }

  const rest = withoutIndex(draft.actions, from);

  return { ...draft, actions: [...rest.slice(0, target), moved, ...rest.slice(target)] };
}

// ---------------------------------------------------------------------------
// Node ids
// ---------------------------------------------------------------------------

export function conditionNodeId(index: number): WorkflowNodeId {
  return `condition:${String(index)}` as WorkflowNodeId;
}

export function actionNodeId(index: number): WorkflowNodeId {
  return `action:${String(index)}` as WorkflowNodeId;
}

/**
 * The node an API error path names. `conditions.2.tagIds` → `condition:2`.
 *
 * The path format is the contract's, not this module's: `workflowReferenceUses`
 * writes it and `translateWorkflowFailure` puts it in `workflow_reference_broken`'s
 * `details[].path`. Anything else — a field on the workflow itself, a shape a
 * future endpoint invents — returns `null` rather than guessing at a node,
 * because highlighting the wrong one is worse than highlighting none.
 */
export function nodeIdForPath(path: string): WorkflowNodeId | null {
  const [collection, rawIndex] = path.split('.');

  if (rawIndex === undefined) {
    return null;
  }

  const index = Number(rawIndex);

  if (!Number.isInteger(index) || index < 0) {
    return null;
  }

  if (collection === 'conditions') {
    return conditionNodeId(index);
  }

  return collection === 'actions' ? actionNodeId(index) : null;
}

/** A node id back into the kind and index it encodes. */
export function parseNodeId(
  id: WorkflowNodeId,
): { kind: 'trigger'; index: null } | { kind: 'condition' | 'action'; index: number } | null {
  if (id === TRIGGER_NODE_ID) {
    return { kind: 'trigger', index: null };
  }

  const [kind, rawIndex] = id.split(':');
  const index = Number(rawIndex);

  if (!Number.isInteger(index) || index < 0) {
    return null;
  }

  if (kind === 'condition' || kind === 'action') {
    return { kind, index };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The three `type` vocabularies are disjoint, which is what lets `replaceNode`
 * take one union and still refuse a mismatch.
 */
function isCondition(
  value: WorkflowTrigger | WorkflowCondition | WorkflowAction,
): value is WorkflowCondition {
  return (WORKFLOW_CONDITION_TYPES as readonly string[]).includes(value.type);
}

function isAction(
  value: WorkflowTrigger | WorkflowCondition | WorkflowAction,
): value is WorkflowAction {
  return (WORKFLOW_ACTION_TYPES as readonly string[]).includes(value.type);
}

function isTrigger(
  value: WorkflowTrigger | WorkflowCondition | WorkflowAction,
): value is WorkflowTrigger {
  return !isCondition(value) && !isAction(value);
}

/** One edge per adjacent pair. The single place edges are ever constructed. */
function chainEdges(nodes: readonly WorkflowGraphNode[]): readonly WorkflowGraphEdge[] {
  return nodes.flatMap((node, index) => {
    const previous = nodes[index - 1];

    // The head of the chain, which nothing points at.
    if (previous === undefined) {
      return [];
    }

    return [{ id: `${previous.id}->${node.id}`, source: previous.id, target: node.id }];
  });
}

function positionAt(positions: readonly XYPosition[], index: number): XYPosition {
  return positions[index] ?? { x: 0, y: index * NODE_PITCH };
}

function withoutIndex<T>(items: readonly T[], index: number): readonly T[] {
  return [...items.slice(0, index), ...items.slice(index + 1)];
}

function withIndex<T>(items: readonly T[], index: number, value: T): readonly T[] {
  return [...items.slice(0, index), value, ...items.slice(index + 1)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

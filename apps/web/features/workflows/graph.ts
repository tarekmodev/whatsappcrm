import type { WorkflowAction, WorkflowCondition, WorkflowTrigger } from '@whatsappcrm/contracts';
import type { WorkflowDraft } from './workflow-form';

/**
 * The node/edge shape the workflow canvas edits, and the two functions that
 * carry it to and from `WorkflowDraft` (TAR-812, against TAR-809's contract).
 *
 * **This module knows nothing about any graph library.** It is plain data and
 * pure functions, so the canvas's persistence behaviour — that an existing
 * workflow survives a load/save round trip byte-identically — is testable
 * without a DOM, without a renderer, and without having chosen a renderer. A
 * `react-flow` (or other) adapter maps *this* onto that library's `Node`/`Edge`
 * types; it does not replace it. That is what keeps the library a rendering
 * decision rather than a persistence one.
 *
 * ## What the graph may be
 *
 * ADR 0009's grammar is a **strictly linear chain**, and this module refuses
 * anything else:
 *
 * ```
 * trigger → condition* → action+
 * ```
 *
 * One trigger; conditions that all must hold (`0009` decision 4 — a supervisor
 * wanting OR writes a second workflow); actions executed in the declared order.
 * There is no branch, no join and no free edge to author, because there is no
 * grammar behind one. A canvas that let a supervisor draw a fork would be
 * offering an expression the API cannot store — the failure this module exists
 * to make impossible rather than to report late.
 *
 * ## One source of truth for order
 *
 * **`nodes` order is the workflow's order. `edges` are derived from it and carry
 * no independent meaning.**
 *
 * Worth stating flatly, because the alternative is subtly broken. An earlier
 * revision read the chain by *walking edges* on the argument that edges are what
 * a supervisor sees — but every editing operation regenerates edges from the
 * node order, so a graph whose two halves disagreed would read one way before an
 * edit and the other way after it. The saved order would then depend on whether
 * the supervisor happened to touch anything first, which is the worst kind of
 * data loss: silent, and invisible until the workflow ran.
 *
 * The reason edges can be derived at all is that this grammar gives the
 * supervisor nothing to rewire — the chain has no branch to author, so an edge
 * is a drawing of the order rather than a statement of it. `draftFromGraph`
 * still *checks* the two agree and refuses (`edges_out_of_sync`) when they do
 * not, which turns a renderer that writes back nodes without rebuilding edges
 * into a loud failure instead of a quiet reordering.
 *
 * ## What it deliberately does not check
 *
 * Whether a condition or action is *complete* — a notify action with no
 * recipient, an empty tag list, an out-of-range `minutes`. That is
 * `validateWorkflowDraft`'s, and stating it twice is how two readings of one
 * rule drift apart. This module owns **topology**; `workflow-form.ts` owns
 * **content**. `draftFromGraph` therefore hands back a draft that is structurally
 * sound and may still be invalid, exactly as `draftFromWorkflow` does.
 */

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export const WORKFLOW_NODE_KINDS = ['trigger', 'condition', 'action'] as const;

export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number];

/**
 * Opaque, and opaque on purpose.
 *
 * Nothing may parse an id to learn a node's kind or position: the whole reason
 * ids exist is that a node keeps its identity — its selection, its focus, its
 * place in the undo stack — while its index moves underneath it. Read
 * `node.kind` and the node's position in `nodes`, never the string.
 */
export type WorkflowNodeId = string;

export type WorkflowGraphNode =
  | { readonly kind: 'trigger'; readonly id: WorkflowNodeId; readonly trigger: WorkflowTrigger }
  | {
      readonly kind: 'condition';
      readonly id: WorkflowNodeId;
      readonly condition: WorkflowCondition;
    }
  | { readonly kind: 'action'; readonly id: WorkflowNodeId; readonly action: WorkflowAction };

export interface WorkflowGraphEdge {
  readonly id: string;
  readonly source: WorkflowNodeId;
  readonly target: WorkflowNodeId;
}

export interface WorkflowGraph {
  /**
   * The trigger, then every condition, then every action — and **the order the
   * workflow is saved in**. See the module note: this is the source of truth,
   * not one of two.
   */
  readonly nodes: readonly WorkflowGraphNode[];
  /**
   * Exactly `nodes.length - 1` edges, each joining consecutive nodes. Derived
   * from `nodes` and never authored: a caller that wants a different order moves
   * a *node*.
   */
  readonly edges: readonly WorkflowGraphEdge[];
  /**
   * The next id to mint, carried rather than derived.
   *
   * Deriving it would mean parsing ids back into numbers, which is the one thing
   * `WorkflowNodeId` promises nobody does. Carrying it also keeps every function
   * here pure and **hydration-safe**: no `crypto.randomUUID`, no `Math.random`,
   * no counter in module scope that a second server render would continue from.
   * A graph built from the same draft is identical on the server and on the
   * client, which is what lets the canvas render before it mounts.
   */
  readonly nextSeq: number;
}

/**
 * Why a graph could not be read back as a workflow. Topology only — see the
 * module note on what this does not check.
 *
 * A code rather than a message: the canvas maps it to copy through the content
 * layer, and these are also the states its own editing operations must never
 * produce. Every one of them is reachable only by a bug or by a hand-built
 * graph, which is why they are worth naming individually — "invalid graph" would
 * tell whoever hits one nothing.
 */
export type WorkflowGraphProblem =
  | 'missing_trigger'
  | 'multiple_triggers'
  | 'trigger_not_first'
  | 'condition_after_action'
  | 'edges_out_of_sync';

export type WorkflowGraphRead =
  | {
      readonly status: 'ok';
      readonly draft: WorkflowDraft;
      /**
       * The condition nodes' ids, in the order their conditions appear in
       * `draft.conditions`, and the same for actions.
       *
       * Handed back because `validateWorkflowDraft` reports failures as
       * `byCondition` / `byAction` keyed by **index** (`workflow-form.ts`), and a
       * canvas renders by node id. Without these, putting "choose who to notify"
       * on the node that caused it means re-deriving the walk order at the call
       * site — a second reading of the order, which is exactly what the module
       * note exists to prevent.
       */
      readonly conditionIds: readonly WorkflowNodeId[];
      readonly actionIds: readonly WorkflowNodeId[];
    }
  | { readonly status: 'invalid'; readonly problem: WorkflowGraphProblem };

// ---------------------------------------------------------------------------
// Draft → graph
// ---------------------------------------------------------------------------

/**
 * Lays a draft out as a chain.
 *
 * Ids are minted from a counter in chain order, so this is a pure function of
 * its argument: the same draft always yields the same graph. Condition and
 * action order is preserved rather than normalised — action order *is* execution
 * order (0009), and condition order, though semantically irrelevant to an AND,
 * is what makes a load/edit-nothing/save round trip produce the payload the
 * workflow already had instead of a reshuffled one that reads as a real change
 * in the audit log.
 */
export function graphFromDraft(draft: WorkflowDraft): WorkflowGraph {
  const nodes: WorkflowGraphNode[] = [{ kind: 'trigger', id: nodeId(0), trigger: draft.trigger }];

  for (const condition of draft.conditions) {
    nodes.push({ kind: 'condition', id: nodeId(nodes.length), condition });
  }

  for (const action of draft.actions) {
    nodes.push({ kind: 'action', id: nodeId(nodes.length), action });
  }

  return { nodes, edges: chainEdges(nodes), nextSeq: nodes.length };
}

// ---------------------------------------------------------------------------
// Graph → draft
// ---------------------------------------------------------------------------

/**
 * Reads the workflow back out of the chain.
 *
 * `name` and `isActive` are passed in because no node holds them. `isActive`
 * especially: the list owns the on/off switch, and a canvas that re-sent it
 * would arm a disabled workflow the moment somebody nudged a node
 * (`WorkflowDraft.isActive` says the same).
 */
export function draftFromGraph(
  graph: WorkflowGraph,
  { name, isActive }: { readonly name: string; readonly isActive: boolean },
): WorkflowGraphRead {
  const triggers = nodesOfKind(graph, 'trigger');
  const trigger = triggers[0];

  if (trigger === undefined) {
    return invalid('missing_trigger');
  }

  if (triggers.length > 1) {
    return invalid('multiple_triggers');
  }

  // Nothing runs before the event that starts the workflow, so the trigger is
  // the head of the chain or the graph has no meaning.
  if (graph.nodes[0] !== trigger) {
    return invalid('trigger_not_first');
  }

  const conditions = nodesOfKind(graph, 'condition');
  const actions = nodesOfKind(graph, 'action');

  // Conditions are a set and actions a sequence, so the boundary between them is
  // the only ordering the bands have to enforce. A condition below an action
  // would read as "check this after doing that", which the engine cannot honour.
  if (!isBandOrdered(graph.nodes)) {
    return invalid('condition_after_action');
  }

  if (!edgesMatchNodes(graph)) {
    return invalid('edges_out_of_sync');
  }

  return {
    status: 'ok',
    draft: {
      name,
      trigger: trigger.trigger,
      conditions: conditions.map((node) => node.condition),
      actions: actions.map((node) => node.action),
      isActive,
    },
    conditionIds: conditions.map((node) => node.id),
    actionIds: actions.map((node) => node.id),
  };
}

/** `[trigger, ...conditions, ...actions]`, with no condition below an action. */
function isBandOrdered(nodes: readonly WorkflowGraphNode[]): boolean {
  let seenAction = false;

  for (const node of nodes) {
    if (node.kind === 'action') {
      seenAction = true;
    } else if (node.kind === 'condition' && seenAction) {
      return false;
    }
  }

  return true;
}

/**
 * Whether `edges` is exactly the chain `nodes` describes.
 *
 * Ids are not compared — they are derived from the endpoints, and a renderer
 * that supplies its own is not thereby wrong. The endpoints and their order are
 * the whole content of an edge here.
 */
function edgesMatchNodes(graph: WorkflowGraph): boolean {
  const expected = chainEdges(graph.nodes);

  if (graph.edges.length !== expected.length) {
    return false;
  }

  return expected.every((edge, index) => {
    const actual = graph.edges[index];

    return actual?.source === edge.source && actual.target === edge.target;
  });
}

// ---------------------------------------------------------------------------
// Editing — the operations that keep the chain a chain
// ---------------------------------------------------------------------------

/**
 * Inserts a condition at `index` among the existing conditions.
 *
 * Rewiring a chain around an insertion is the one piece of canvas editing that
 * is easy to get quietly wrong, so it lives here with the round-trip tests
 * rather than inside a component: every operation below rebuilds the edge list
 * from the node order, which makes an orphaned or duplicated edge unrepresentable
 * instead of merely unlikely.
 *
 * An index past the end appends, matching `Array.prototype.splice`.
 */
export function insertCondition(
  graph: WorkflowGraph,
  condition: WorkflowCondition,
  index: number,
): WorkflowGraph {
  const node: WorkflowGraphNode = { kind: 'condition', id: nodeId(graph.nextSeq), condition };

  return rebuild(
    graph,
    { conditions: spliced(nodesOfKind(graph, 'condition'), node, index) },
    graph.nextSeq + 1,
  );
}

/** Inserts an action at `index` among the existing actions. */
export function insertAction(
  graph: WorkflowGraph,
  action: WorkflowAction,
  index: number,
): WorkflowGraph {
  const node: WorkflowGraphNode = { kind: 'action', id: nodeId(graph.nextSeq), action };

  return rebuild(
    graph,
    { actions: spliced(nodesOfKind(graph, 'action'), node, index) },
    graph.nextSeq + 1,
  );
}

/**
 * Removes a node and closes the chain over the gap.
 *
 * Removing the trigger is refused rather than allowed-and-reported: every
 * workflow has exactly one and there is no editing state in which having none is
 * a step towards anything. An unknown id is a no-op — a double-click on delete
 * should not be an error.
 */
export function removeNode(graph: WorkflowGraph, id: WorkflowNodeId): WorkflowGraph {
  const node = graph.nodes.find((candidate) => candidate.id === id);

  if (node === undefined || node.kind === 'trigger') {
    return graph;
  }

  const remaining = nodesOfKind(graph, node.kind).filter((candidate) => candidate.id !== id);

  return rebuild(
    graph,
    node.kind === 'condition' ? { conditions: remaining } : { actions: remaining },
    graph.nextSeq,
  );
}

/**
 * Moves a node to `indexWithinKind` — a position **among the nodes of its own
 * kind**, not a position on the canvas.
 *
 * The distinction matters and the name carries it, because the two coincide only
 * when there are no conditions: in a graph of one trigger, two conditions and
 * three actions, dropping an action "just below the trigger" is canvas position
 * 1 but `indexWithinKind` 0. The caller converts; a renderer's drop index passed
 * through raw would move the right node to the wrong place with no error.
 *
 * Moving between kinds is not a move this grammar has, so an out-of-range index
 * is clamped into the node's own band rather than refused — the supervisor gets
 * the nearest legal position and `draftFromGraph` never sees a
 * `condition_after_action` shape at all. The trigger does not move.
 */
export function moveNode(
  graph: WorkflowGraph,
  id: WorkflowNodeId,
  indexWithinKind: number,
): WorkflowGraph {
  const node = graph.nodes.find((candidate) => candidate.id === id);

  if (node === undefined || node.kind === 'trigger') {
    return graph;
  }

  const sameKind = nodesOfKind(graph, node.kind);
  const from = sameKind.findIndex((candidate) => candidate.id === id);
  const to = clamp(indexWithinKind, 0, sameKind.length - 1);

  if (from === to) {
    return graph;
  }

  const reordered = spliced(
    sameKind.filter((candidate) => candidate.id !== id),
    node,
    to,
  );

  return rebuild(
    graph,
    node.kind === 'condition' ? { conditions: reordered } : { actions: reordered },
    graph.nextSeq,
  );
}

/**
 * Replaces the trigger a node carries.
 *
 * Kind-specific rather than one generic `updateNode`, so a caller cannot hand a
 * condition to the trigger node. Ids are opaque, though, so an id naming a node
 * of another kind is still reachable — a detail panel holding a stale id after a
 * remove is the realistic path — and that returns the graph **unchanged**, the
 * same no-op `removeNode` and `moveNode` give an unknown id. Returning a fresh
 * object with the edit dropped would re-render the canvas and snap the field
 * back with nothing to explain it.
 */
export function updateTriggerNode(
  graph: WorkflowGraph,
  id: WorkflowNodeId,
  trigger: WorkflowTrigger,
): WorkflowGraph {
  const node = graph.nodes.find((candidate) => candidate.id === id);

  return node?.kind === 'trigger' ? replaceNode(graph, { ...node, trigger }) : graph;
}

/** Replaces the condition a node carries. Unchanged for an id of another kind. */
export function updateConditionNode(
  graph: WorkflowGraph,
  id: WorkflowNodeId,
  condition: WorkflowCondition,
): WorkflowGraph {
  const node = graph.nodes.find((candidate) => candidate.id === id);

  return node?.kind === 'condition' ? replaceNode(graph, { ...node, condition }) : graph;
}

/** Replaces the action a node carries. Unchanged for an id of another kind. */
export function updateActionNode(
  graph: WorkflowGraph,
  id: WorkflowNodeId,
  action: WorkflowAction,
): WorkflowGraph {
  const node = graph.nodes.find((candidate) => candidate.id === id);

  return node?.kind === 'action' ? replaceNode(graph, { ...node, action }) : graph;
}

/** The nodes of one kind, in the order they appear in `nodes`. */
export function nodesOfKind<K extends WorkflowNodeKind>(
  graph: WorkflowGraph,
  kind: K,
): readonly Extract<WorkflowGraphNode, { kind: K }>[] {
  return graph.nodes.filter(
    (node): node is Extract<WorkflowGraphNode, { kind: K }> => node.kind === kind,
  );
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function nodeId(seq: number): WorkflowNodeId {
  return `n${String(seq)}`;
}

function edgeId(source: WorkflowNodeId, target: WorkflowNodeId): string {
  return `${source}->${target}`;
}

/** One edge per adjacent pair. The single place edges are ever constructed. */
function chainEdges(nodes: readonly WorkflowGraphNode[]): readonly WorkflowGraphEdge[] {
  return nodes.flatMap((node, index) => {
    const previous = nodes[index - 1];

    // The head of the chain, which nothing points at.
    if (previous === undefined) {
      return [];
    }

    return [{ id: edgeId(previous.id, node.id), source: previous.id, target: node.id }];
  });
}

/**
 * Reassembles the whole chain from its three bands.
 *
 * Every editing operation goes through here rather than splicing `nodes`
 * directly, which is what makes `trigger → conditions → actions` an invariant of
 * the module instead of a rule each operation has to remember. The edge list is
 * rebuilt from the result, so an orphaned or duplicated edge is unrepresentable.
 */
function rebuild(
  graph: WorkflowGraph,
  bands: {
    readonly conditions?: readonly WorkflowGraphNode[];
    readonly actions?: readonly WorkflowGraphNode[];
  },
  nextSeq: number,
): WorkflowGraph {
  const nodes = [
    ...nodesOfKind(graph, 'trigger'),
    ...(bands.conditions ?? nodesOfKind(graph, 'condition')),
    ...(bands.actions ?? nodesOfKind(graph, 'action')),
  ];

  return { nodes, edges: chainEdges(nodes), nextSeq };
}

/**
 * Swaps one node for another with the same id.
 *
 * Edges key off ids and no id changed, so `edges` is carried by reference rather
 * than rebuilt — a new edge array on every keystroke would remount the canvas's
 * edge layer.
 */
function replaceNode(graph: WorkflowGraph, node: WorkflowGraphNode): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((candidate) => (candidate.id === node.id ? node : candidate)),
  };
}

/** `splice`-style insertion, clamped, without mutating the input. */
function spliced(
  nodes: readonly WorkflowGraphNode[],
  node: WorkflowGraphNode,
  index: number,
): readonly WorkflowGraphNode[] {
  const at = clamp(index, 0, nodes.length);

  return [...nodes.slice(0, at), node, ...nodes.slice(at)];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function invalid(problem: WorkflowGraphProblem): WorkflowGraphRead {
  return { status: 'invalid', problem };
}

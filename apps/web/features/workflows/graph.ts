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
  /** Chain order: the trigger, then conditions, then actions. */
  readonly nodes: readonly WorkflowGraphNode[];
  /** Exactly `nodes.length - 1` edges, each joining consecutive nodes. */
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
  | 'forked'
  | 'cycle'
  | 'disconnected'
  | 'condition_after_action';

export type WorkflowGraphRead =
  | { readonly status: 'ok'; readonly draft: WorkflowDraft }
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
 * Walks the chain and reads the workflow back out.
 *
 * The walk follows **edges**, not the `nodes` array, and that is the point: the
 * edges are what a supervisor can see on the canvas, so they are what the saved
 * workflow has to agree with. Reading the array instead would let a rewiring bug
 * save an order different from the one on screen — silently, and only visibly
 * once the workflow ran.
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

  // The head of the chain is the node nothing points at. If that is not the
  // trigger, some node sits upstream of it — a shape with no meaning, since
  // nothing runs before the event that starts the workflow.
  if (graph.edges.some((edge) => edge.target === trigger.id)) {
    return invalid('trigger_not_first');
  }

  const walk = walkChain(graph, trigger.id);

  if (walk.status === 'invalid') {
    return walk;
  }

  const conditions: WorkflowCondition[] = [];
  const actions: WorkflowAction[] = [];

  for (const node of walk.nodes) {
    switch (node.kind) {
      case 'trigger':
        break;

      case 'condition':
        // Conditions are a set and actions a sequence, so the boundary between
        // them is the only ordering the chain has to enforce. A condition below
        // an action would read as "check this after doing that", which the
        // engine has no way to honour.
        if (actions.length > 0) {
          return invalid('condition_after_action');
        }

        conditions.push(node.condition);
        break;

      case 'action':
        actions.push(node.action);
        break;
    }
  }

  return {
    status: 'ok',
    draft: { name, trigger: trigger.trigger, conditions, actions, isActive },
  };
}

/**
 * Follows single edges from `startId` and returns every node in chain order.
 *
 * Three rejections, and between them they are the whole difference between "a
 * chain" and "a graph": a node with two ways out (`forked`), a walk that comes
 * back to where it has been (`cycle`), and a node the walk never arrives at
 * (`disconnected`).
 *
 * There is deliberately no separate check for two edges arriving at one node. A
 * join reachable from the trigger needs a fork upstream of it, which
 * `forked` catches first; a join from a node that is *not* reachable leaves that
 * node uncovered, which `disconnected` catches after. Adding the check as well
 * would only shadow `cycle` — a back edge is also a second arrival — and report
 * a fork for a loop the supervisor can plainly see is a loop.
 */
function walkChain(
  graph: WorkflowGraph,
  startId: WorkflowNodeId,
):
  | { status: 'ok'; nodes: readonly WorkflowGraphNode[] }
  | { status: 'invalid'; problem: WorkflowGraphProblem } {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<WorkflowNodeId, WorkflowNodeId[]>();

  for (const edge of graph.edges) {
    // An edge to a node that is not in the graph is a dangling wire; treating it
    // as a fork would be wrong, so it counts as the disconnection it is.
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      return { status: 'invalid', problem: 'disconnected' };
    }

    const targets = outgoing.get(edge.source);

    if (targets === undefined) {
      outgoing.set(edge.source, [edge.target]);
    } else {
      targets.push(edge.target);
    }
  }

  const ordered: WorkflowGraphNode[] = [];
  const seen = new Set<WorkflowNodeId>();
  let currentId: WorkflowNodeId | undefined = startId;

  while (currentId !== undefined) {
    if (seen.has(currentId)) {
      return { status: 'invalid', problem: 'cycle' };
    }

    seen.add(currentId);

    const node = byId.get(currentId);

    // Unreachable while `startId` is a real node and every edge was checked
    // above, but the map lookup is nullable and a non-null assertion here would
    // be the kind that turns a future bug into a crash.
    if (node === undefined) {
      return { status: 'invalid', problem: 'disconnected' };
    }

    ordered.push(node);

    const next: readonly WorkflowNodeId[] = outgoing.get(currentId) ?? [];

    if (next.length > 1) {
      return { status: 'invalid', problem: 'forked' };
    }

    currentId = next[0];
  }

  if (ordered.length !== graph.nodes.length) {
    return { status: 'invalid', problem: 'disconnected' };
  }

  return { status: 'ok', nodes: ordered };
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
 * Moves a node to `index` **within its own kind**, which is the only move the
 * grammar has room for.
 *
 * A drag that would carry an action above a condition is clamped back into its
 * own band rather than refused: the supervisor gets the nearest legal position,
 * and `draftFromGraph` never sees the `condition_after_action` shape at all. The
 * trigger does not move.
 */
export function moveNode(graph: WorkflowGraph, id: WorkflowNodeId, index: number): WorkflowGraph {
  const node = graph.nodes.find((candidate) => candidate.id === id);

  if (node === undefined || node.kind === 'trigger') {
    return graph;
  }

  const sameKind = nodesOfKind(graph, node.kind);
  const from = sameKind.findIndex((candidate) => candidate.id === id);
  const to = clamp(index, 0, sameKind.length - 1);

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
 * Replaces the trigger a node carries. Kind-specific rather than one generic
 * `updateNode`, so a caller cannot hand a condition to the trigger node and only
 * learn about it when the API refuses the save.
 */
export function updateTriggerNode(
  graph: WorkflowGraph,
  id: WorkflowNodeId,
  trigger: WorkflowTrigger,
): WorkflowGraph {
  return mapNode(graph, id, (node) => (node.kind === 'trigger' ? { ...node, trigger } : node));
}

/** Replaces the condition a node carries. */
export function updateConditionNode(
  graph: WorkflowGraph,
  id: WorkflowNodeId,
  condition: WorkflowCondition,
): WorkflowGraph {
  return mapNode(graph, id, (node) => (node.kind === 'condition' ? { ...node, condition } : node));
}

/** Replaces the action a node carries. */
export function updateActionNode(
  graph: WorkflowGraph,
  id: WorkflowNodeId,
  action: WorkflowAction,
): WorkflowGraph {
  return mapNode(graph, id, (node) => (node.kind === 'action' ? { ...node, action } : node));
}

/** The nodes of one kind, in chain order. */
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

/** `splice`-style insertion, clamped, without mutating the input. */
function spliced(
  nodes: readonly WorkflowGraphNode[],
  node: WorkflowGraphNode,
  index: number,
): readonly WorkflowGraphNode[] {
  const at = clamp(index, 0, nodes.length);

  return [...nodes.slice(0, at), node, ...nodes.slice(at)];
}

function mapNode(
  graph: WorkflowGraph,
  id: WorkflowNodeId,
  replace: (node: WorkflowGraphNode) => WorkflowGraphNode,
): WorkflowGraph {
  const nodes = graph.nodes.map((node) => (node.id === id ? replace(node) : node));

  // Edges key off ids and no id changed, so they are carried rather than rebuilt
  // — a new edge array on every keystroke would remount the canvas's edge layer.
  return { ...graph, nodes };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function invalid(problem: WorkflowGraphProblem): WorkflowGraphRead {
  return { status: 'invalid', problem };
}

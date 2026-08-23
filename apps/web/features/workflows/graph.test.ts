import { describe, expect, it } from 'vitest';
import {
  WorkflowCreateInputSchema,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowResponse,
  type WorkflowTrigger,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import {
  draftFromGraph,
  graphFromDraft,
  insertAction,
  insertCondition,
  moveNode,
  nodesOfKind,
  removeNode,
  updateActionNode,
  updateConditionNode,
  updateTriggerNode,
  type WorkflowGraph,
  type WorkflowGraphNode,
  type WorkflowNodeKind,
} from './graph';
import { draftFromWorkflow, validateWorkflowDraft, type WorkflowDraft } from './workflow-form';

/**
 * The canvas's persistence behaviour, tested without a canvas.
 *
 * The acceptance criterion these exist for is "existing workflows created via
 * the old form-dialog editor render correctly on the new canvas with no data
 * loss" — which is a statement about a *round trip*, and so is provable here
 * rather than by opening a browser and squinting at a diff. If
 * `draftFromGraph(graphFromDraft(d))` is not `d` for every shape ADR 0009's
 * grammar allows, the canvas loses supervisor data, whatever it looks like.
 */

const TEAM_ID = '0192f002-0000-7000-8000-000000000201';
const OTHER_TEAM_ID = '0192f002-0000-7000-8000-000000000202';
const USER_ID = '0192f001-0000-7000-8000-000000000102';
const TAG_ID = '0192f00b-0000-7000-8000-000000000b03';
const OTHER_TAG_ID = '0192f00b-0000-7000-8000-000000000b04';

/** Every trigger in `WORKFLOW_TRIGGER_TYPES`, including the parameterised one. */
const CREATED: WorkflowTrigger = { type: 'ticket_created' };
const STATUS_CHANGED: WorkflowTrigger = { type: 'ticket_status_changed' };
const ASSIGNED: WorkflowTrigger = { type: 'ticket_assigned' };
const SLA_BREACHED: WorkflowTrigger = { type: 'ticket_sla_breached' };
const UNRESOLVED_FOR: WorkflowTrigger = { type: 'ticket_unresolved_for', minutes: 90 };

const ALL_TRIGGERS: readonly WorkflowTrigger[] = [
  CREATED,
  STATUS_CHANGED,
  ASSIGNED,
  SLA_BREACHED,
  UNRESOLVED_FOR,
];

/** Every member of `WorkflowConditionSchema`'s union, including both null-narrowings. */
const STATUS_IN: WorkflowCondition = {
  type: 'ticket_status',
  operator: 'in',
  values: ['open', 'pending'],
};
const PRIORITY_NOT_IN: WorkflowCondition = {
  type: 'ticket_priority',
  operator: 'not_in',
  values: ['low'],
};
const UNASSIGNED: WorkflowCondition = {
  type: 'ticket_assignment',
  state: 'unassigned',
  teamId: null,
  userId: null,
};
const ASSIGNED_TO_TEAM: WorkflowCondition = {
  type: 'ticket_assignment',
  state: 'assigned_to_team',
  teamId: TEAM_ID,
  userId: null,
};
const ASSIGNED_TO_USER: WorkflowCondition = {
  type: 'ticket_assignment',
  state: 'assigned_to_user',
  teamId: null,
  userId: USER_ID,
};
const TICKET_TAGGED: WorkflowCondition = {
  type: 'ticket_tag',
  match: 'any',
  tagIds: [TAG_ID, OTHER_TAG_ID],
};
const CONTACT_UNTAGGED: WorkflowCondition = {
  type: 'contact_tag',
  match: 'none',
  tagIds: [TAG_ID],
};
const OLDER_THAN: WorkflowCondition = { type: 'ticket_age', operator: 'gte', minutes: 120 };
const OUT_OF_HOURS: WorkflowCondition = { type: 'business_hours', within: false };

const ALL_CONDITIONS: readonly WorkflowCondition[] = [
  STATUS_IN,
  PRIORITY_NOT_IN,
  UNASSIGNED,
  ASSIGNED_TO_TEAM,
  ASSIGNED_TO_USER,
  TICKET_TAGGED,
  CONTACT_UNTAGGED,
  OLDER_THAN,
  OUT_OF_HOURS,
];

/** Every member of `WorkflowActionSchema`'s union, and every notify audience. */
const ADD_TAG: WorkflowAction = { type: 'add_ticket_tag', tagId: TAG_ID };
const REASSIGN_TEAM: WorkflowAction = {
  type: 'reassign',
  target: { kind: 'team', teamId: TEAM_ID },
};
const REASSIGN_USER: WorkflowAction = {
  type: 'reassign',
  target: { kind: 'user', userId: USER_ID },
};
const NOTIFY_SUPERVISORS: WorkflowAction = {
  type: 'notify',
  audience: 'supervisors',
  userId: null,
  teamId: null,
  message: 'Escalated',
};
const NOTIFY_USER: WorkflowAction = {
  type: 'notify',
  audience: 'user',
  userId: USER_ID,
  teamId: null,
  message: null,
};
const NOTIFY_TEAM: WorkflowAction = {
  type: 'notify',
  audience: 'team',
  userId: null,
  teamId: TEAM_ID,
  message: 'Take a look',
};
const SET_PENDING: WorkflowAction = { type: 'set_status', status: 'pending' };
const SET_URGENT: WorkflowAction = { type: 'set_priority', priority: 'urgent' };

const ALL_ACTIONS: readonly WorkflowAction[] = [
  ADD_TAG,
  REASSIGN_TEAM,
  REASSIGN_USER,
  NOTIFY_SUPERVISORS,
  NOTIFY_USER,
  NOTIFY_TEAM,
  SET_PENDING,
  SET_URGENT,
];

const CARRIED = { name: 'Escalate stale tickets', isActive: false };

function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    name: CARRIED.name,
    trigger: { type: 'ticket_created' },
    conditions: [],
    actions: [{ type: 'set_priority', priority: 'high' }],
    isActive: false,
    ...overrides,
  };
}

/** The draft a graph reads back as, or a failure naming the topology problem. */
function readBack(graph: WorkflowGraph, carried = CARRIED): WorkflowDraft {
  const read = draftFromGraph(graph, carried);

  if (read.status !== 'ok') {
    throw new Error(`expected a readable graph, got: ${read.problem}`);
  }

  return read.draft;
}

describe('graphFromDraft', () => {
  it('lays the workflow out as trigger → conditions → actions, in that order', () => {
    const graph = graphFromDraft(
      draft({
        conditions: [STATUS_IN, OLDER_THAN],
        actions: [ADD_TAG, SET_PENDING],
      }),
    );

    expect(graph.nodes.map((node) => node.kind)).toEqual([
      'trigger',
      'condition',
      'condition',
      'action',
      'action',
    ]);
  });

  it('joins every adjacent pair with exactly one edge and leaves none dangling', () => {
    const graph = graphFromDraft(
      draft({ conditions: [STATUS_IN], actions: [ADD_TAG, REASSIGN_TEAM] }),
    );

    expect(graph.edges).toHaveLength(graph.nodes.length - 1);
    expect(graph.edges.map((edge) => [edge.source, edge.target])).toEqual([
      [nodeAt(graph, 0).id, nodeAt(graph, 1).id],
      [nodeAt(graph, 1).id, nodeAt(graph, 2).id],
      [nodeAt(graph, 2).id, nodeAt(graph, 3).id],
    ]);
  });

  it('gives a workflow with no conditions a trigger wired straight to its first action', () => {
    // Empty is legal and common — "every time this trigger fires, do this"
    // (0009 decision 4). The canvas must not invent a placeholder node for it.
    const graph = graphFromDraft(draft());

    expect(graph.nodes.map((node) => node.kind)).toEqual(['trigger', 'action']);
    expect(graph.edges).toHaveLength(1);
  });

  it('is a pure function of the draft, so the server and the client build the same graph', () => {
    // The hydration guarantee, pinned. A `crypto.randomUUID()` or a module-scope
    // counter would pass every other test here and mismatch on first paint.
    const source = draft({ conditions: [UNASSIGNED], actions: [NOTIFY_SUPERVISORS] });

    expect(graphFromDraft(source)).toEqual(graphFromDraft(source));
  });

  it('mints a distinct id for every node', () => {
    const graph = graphFromDraft(
      draft({ conditions: [...ALL_CONDITIONS], actions: ALL_ACTIONS.slice(0, 5) }),
    );

    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
  });
});

describe('round trip', () => {
  it.each(ALL_TRIGGERS.map((trigger) => [trigger.type, trigger] as const))(
    'preserves the %s trigger',
    (_type, trigger) => {
      const source = draft({ trigger });

      expect(readBack(graphFromDraft(source))).toEqual(source);
    },
  );

  it.each(ALL_CONDITIONS.map((condition) => [describeCase(condition), condition] as const))(
    'preserves the %s condition',
    (_label, condition) => {
      const source = draft({ conditions: [condition] });

      expect(readBack(graphFromDraft(source))).toEqual(source);
    },
  );

  it.each(ALL_ACTIONS.map((action) => [describeCase(action), action] as const))(
    'preserves the %s action',
    (_label, action) => {
      const source = draft({ actions: [action] });

      expect(readBack(graphFromDraft(source))).toEqual(source);
    },
  );

  it('preserves a workflow holding every condition and the full action list at once', () => {
    // The caps are 10 conditions and 5 actions; this is 9 and 5, so it is also
    // the widest workflow a supervisor can actually save.
    const source = draft({
      trigger: { type: 'ticket_unresolved_for', minutes: 43_200 },
      conditions: [...ALL_CONDITIONS],
      actions: ALL_ACTIONS.slice(0, 5),
    });

    expect(readBack(graphFromDraft(source))).toEqual(source);
  });

  it('preserves action order, which is execution order', () => {
    const ordered: readonly WorkflowAction[] = [
      { type: 'set_status', status: 'open' },
      { type: 'add_ticket_tag', tagId: TAG_ID },
      { type: 'set_priority', priority: 'urgent' },
    ];

    expect(readBack(graphFromDraft(draft({ actions: [...ordered] }))).actions).toEqual(ordered);
  });

  it('preserves condition order even though conditions are an unordered AND', () => {
    // Not a semantic requirement — an AND does not care. It is an audit-log one:
    // a load/edit-nothing/save must not write a reshuffled definition that reads
    // as a real change.
    const ordered = [OUT_OF_HOURS, STATUS_IN, TICKET_TAGGED];

    expect(readBack(graphFromDraft(draft({ conditions: ordered }))).conditions).toEqual(ordered);
  });

  it('carries a saved workflow to the same API payload it already had', () => {
    // The acceptance criterion end to end: an existing workflow, opened on the
    // canvas, changed in no way and saved, produces the definition it started
    // with — through the same `validateWorkflowDraft` the form dialogs submit.
    const workflow = savedWorkflow();
    const opened = draftFromWorkflow(workflow);
    const saved = validateWorkflowDraft(
      readBack(graphFromDraft(opened), {
        name: opened.name,
        isActive: opened.isActive,
      }),
      content,
    );

    expect(saved.status).toBe('valid');
    expect(saved.status === 'valid' && saved.input).toEqual(
      WorkflowCreateInputSchema.parse({
        name: workflow.name,
        trigger: workflow.trigger,
        conditions: workflow.conditions,
        actions: workflow.actions,
        isActive: workflow.isActive,
      }),
    );
  });

  it('does not let the graph re-arm a workflow the list switched off', () => {
    // `isActive` lives on the draft and never on a node, so there is no node a
    // supervisor could nudge that would change it. Pinned because the form has
    // the same rule and it is the one mistake here that writes to real tickets.
    const graph = graphFromDraft(draft({ isActive: false }));

    expect(readBack(graph, { name: CARRIED.name, isActive: false }).isActive).toBe(false);
  });
});

describe('draftFromGraph', () => {
  it('reads the chain from the node order, and says so when the edges disagree', () => {
    // The module's one source-of-truth rule, pinned from both sides. An earlier
    // revision walked the edges here while every editing operation rebuilt them
    // from `nodes`, so a graph like this one read one way before an edit and the
    // other way after it — the saved order depending on whether the supervisor
    // happened to touch anything first.
    const graph = graphFromDraft(draft({ actions: [SET_PENDING, SET_URGENT] }));
    const trigger = nodeAt(graph, 0);
    const first = nodeAt(graph, 1);
    const second = nodeAt(graph, 2);

    expect(
      draftFromGraph(
        {
          ...graph,
          edges: [
            { id: 'a', source: trigger.id, target: second.id },
            { id: 'b', source: second.id, target: first.id },
          ],
        },
        CARRIED,
      ),
    ).toEqual({ status: 'invalid', problem: 'edges_out_of_sync' });
  });

  it('cannot be made to save one order before an edit and another after it', () => {
    // The regression the rule above exists for, stated as behaviour: whatever a
    // stale edge set does, it must not be that inserting an unrelated third
    // action silently swaps the two the supervisor already had.
    const graph = graphFromDraft(draft({ actions: [SET_PENDING, SET_URGENT] }));
    const stale: WorkflowGraph = {
      ...graph,
      edges: [
        { id: 'a', source: nodeAt(graph, 0).id, target: nodeAt(graph, 2).id },
        { id: 'b', source: nodeAt(graph, 2).id, target: nodeAt(graph, 1).id },
      ],
    };

    const before = draftFromGraph(stale, CARRIED);
    const after = draftFromGraph(insertAction(stale, ADD_TAG, 2), CARRIED);

    expect(before.status).toBe('invalid');
    expect(after.status === 'ok' && after.draft.actions).toEqual([
      SET_PENDING,
      SET_URGENT,
      ADD_TAG,
    ]);
  });

  it('hands back the node ids behind each condition and action, in draft order', () => {
    // `validateWorkflowDraft` reports `byCondition` / `byAction` by index, and a
    // canvas renders by id. Without these the only mapping is a second reading of
    // the order at the call site, which is the thing the module rules out.
    const graph = graphFromDraft(
      draft({ conditions: [STATUS_IN, OLDER_THAN], actions: [ADD_TAG, SET_PENDING] }),
    );
    const read = draftFromGraph(graph, CARRIED);

    expect(read.status).toBe('ok');

    if (read.status !== 'ok') {
      return;
    }

    expect(read.conditionIds).toEqual(nodesOfKind(graph, 'condition').map((node) => node.id));
    expect(read.actionIds).toEqual(nodesOfKind(graph, 'action').map((node) => node.id));
    expect(read.actionIds).toHaveLength(read.draft.actions.length);
  });

  it('refuses a graph with no trigger', () => {
    const graph = graphFromDraft(draft());

    expect(draftFromGraph({ ...graph, nodes: graph.nodes.slice(1), edges: [] }, CARRIED)).toEqual({
      status: 'invalid',
      problem: 'missing_trigger',
    });
  });

  it('refuses a graph with two triggers', () => {
    const graph = graphFromDraft(draft());
    const trigger = nodeAt(graph, 0);

    expect(
      draftFromGraph({ ...graph, nodes: [...graph.nodes, { ...trigger, id: 'extra' }] }, CARRIED),
    ).toEqual({ status: 'invalid', problem: 'multiple_triggers' });
  });

  it('refuses a graph whose head is not the trigger', () => {
    const graph = graphFromDraft(draft());

    expect(
      draftFromGraph({ ...graph, nodes: [...graph.nodes].reverse(), edges: [] }, CARRIED),
    ).toEqual({ status: 'invalid', problem: 'trigger_not_first' });
  });

  it('refuses a condition ordered below an action', () => {
    const graph = graphFromDraft(draft({ conditions: [STATUS_IN] }));
    const trigger = nodeAt(graph, 0);
    const condition = nodeAt(graph, 1);
    const action = nodeAt(graph, 2);

    expect(
      draftFromGraph({ ...graph, nodes: [trigger, action, condition], edges: [] }, CARRIED),
    ).toEqual({ status: 'invalid', problem: 'condition_after_action' });
  });

  it('refuses a chain missing an edge', () => {
    const graph = graphFromDraft(draft({ actions: [SET_PENDING, SET_URGENT] }));

    expect(draftFromGraph({ ...graph, edges: graph.edges.slice(0, 1) }, CARRIED)).toEqual({
      status: 'invalid',
      problem: 'edges_out_of_sync',
    });
  });

  it('refuses an edge pointing at a node that is not in the graph', () => {
    const graph = graphFromDraft(draft());

    expect(
      draftFromGraph(
        { ...graph, edges: [{ id: 'x', source: nodeAt(graph, 0).id, target: 'gone' }] },
        CARRIED,
      ),
    ).toEqual({ status: 'invalid', problem: 'edges_out_of_sync' });
  });

  it('accepts edges whose ids a renderer supplied, since ids carry no meaning', () => {
    const graph = graphFromDraft(draft());
    const renamed = graph.edges.map((edge, index) => ({
      ...edge,
      id: `renderer-${String(index)}`,
    }));

    expect(draftFromGraph({ ...graph, edges: renamed }, CARRIED).status).toBe('ok');
  });

  it('leaves an incomplete workflow to the form rather than reporting it here', () => {
    // No actions is invalid, but it is `validateWorkflowDraft`'s to say so — the
    // graph is a perfectly good chain and this module owns topology only.
    const graph = graphFromDraft(draft({ actions: [] }));
    const read = draftFromGraph(graph, CARRIED);

    expect(read.status).toBe('ok');
    expect(validateWorkflowDraft(readBack(graph), content)).toMatchObject({
      status: 'invalid',
      errors: { actions: content.workflows.actionsRequiredError },
    });
  });
});

describe('editing', () => {
  it('inserts a condition between the trigger and the actions', () => {
    const graph = insertCondition(graphFromDraft(draft()), STATUS_IN, 0);

    expect(graph.nodes.map((node) => node.kind)).toEqual(['trigger', 'condition', 'action']);
    expect(readBack(graph).conditions).toEqual([STATUS_IN]);
  });

  it('inserts a condition at the requested position among the existing ones', () => {
    const graph = insertCondition(
      graphFromDraft(draft({ conditions: [STATUS_IN, OLDER_THAN] })),
      OUT_OF_HOURS,
      1,
    );

    expect(readBack(graph).conditions).toEqual([STATUS_IN, OUT_OF_HOURS, OLDER_THAN]);
  });

  it('appends when the index is past the end', () => {
    const graph = insertCondition(graphFromDraft(draft()), STATUS_IN, 99);

    expect(readBack(graph).conditions).toEqual([STATUS_IN]);
  });

  it('inserts an action at the requested position, below every condition', () => {
    const graph = insertAction(
      graphFromDraft(draft({ conditions: [STATUS_IN], actions: [SET_PENDING] })),
      ADD_TAG,
      0,
    );

    expect(graph.nodes.map((node) => node.kind)).toEqual([
      'trigger',
      'condition',
      'action',
      'action',
    ]);
    expect(readBack(graph).actions).toEqual([ADD_TAG, SET_PENDING]);
  });

  it('gives every inserted node an id that collides with nothing already there', () => {
    let graph = graphFromDraft(draft({ conditions: [STATUS_IN] }));

    graph = removeNode(graph, nodeAt(graph, 1).id);
    graph = insertCondition(graph, OLDER_THAN, 0);
    graph = insertCondition(graph, OUT_OF_HOURS, 0);

    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(graph.nodes.length);
  });

  it('closes the chain over a removed node', () => {
    const source = graphFromDraft(draft({ conditions: [STATUS_IN, OLDER_THAN] }));
    const graph = removeNode(source, nodeAt(source, 1).id);

    expect(readBack(graph).conditions).toEqual([OLDER_THAN]);
    expect(graph.edges).toHaveLength(graph.nodes.length - 1);
  });

  it('refuses to remove the trigger', () => {
    const source = graphFromDraft(draft());

    expect(removeNode(source, nodeAt(source, 0).id)).toBe(source);
  });

  it('ignores an unknown id rather than erroring, so a double delete is harmless', () => {
    const source = graphFromDraft(draft());

    expect(removeNode(source, 'gone')).toBe(source);
  });

  it('reorders actions within the action band', () => {
    const source = graphFromDraft(draft({ actions: [ADD_TAG, SET_PENDING, SET_URGENT] }));
    const moved = moveNode(source, kindAt(source, 'action', 2).id, 0);

    expect(readBack(moved).actions).toEqual([SET_URGENT, ADD_TAG, SET_PENDING]);
  });

  it('reorders conditions without disturbing the actions below them', () => {
    const source = graphFromDraft(
      draft({
        conditions: [STATUS_IN, OLDER_THAN],
        actions: [ADD_TAG, SET_PENDING],
      }),
    );
    const moved = moveNode(source, kindAt(source, 'condition', 1).id, 0);
    const read = readBack(moved);

    expect(read.conditions).toEqual([OLDER_THAN, STATUS_IN]);
    expect(read.actions).toEqual([ADD_TAG, SET_PENDING]);
  });

  it('clamps a drag that would carry an action above the conditions', () => {
    // The supervisor gets the nearest legal position instead of a refusal, and
    // `draftFromGraph` never sees `condition_after_action` at all.
    const source = graphFromDraft(
      draft({ conditions: [STATUS_IN], actions: [ADD_TAG, SET_PENDING] }),
    );
    const moved = moveNode(source, kindAt(source, 'action', 1).id, -5);

    expect(moved.nodes.map((node) => node.kind)).toEqual([
      'trigger',
      'condition',
      'action',
      'action',
    ]);
    expect(readBack(moved).actions).toEqual([SET_PENDING, ADD_TAG]);
  });

  it('does not move the trigger', () => {
    const source = graphFromDraft(draft());

    expect(moveNode(source, nodeAt(source, 0).id, 1)).toBe(source);
  });

  it('replaces what a node carries without changing the chain', () => {
    const source = graphFromDraft(draft({ conditions: [STATUS_IN], actions: [ADD_TAG] }));
    const trigger = nodeAt(source, 0);
    const condition = nodeAt(source, 1);
    const action = nodeAt(source, 2);

    let graph = updateTriggerNode(source, trigger.id, UNRESOLVED_FOR);
    graph = updateConditionNode(graph, condition.id, OUT_OF_HOURS);
    graph = updateActionNode(graph, action.id, SET_URGENT);

    expect(graph.edges).toEqual(source.edges);
    expect(readBack(graph)).toEqual(
      draft({
        trigger: UNRESOLVED_FOR,
        conditions: [OUT_OF_HOURS],
        actions: [SET_URGENT],
      }),
    );
  });

  it('leaves the edge array identical on an update, so the canvas does not remount it', () => {
    const source = graphFromDraft(draft());
    const graph = updateTriggerNode(source, nodeAt(source, 0).id, STATUS_CHANGED);

    expect(graph.edges).toBe(source.edges);
  });

  it('returns the graph unchanged when an update names a node of another kind', () => {
    // Ids are opaque, so a detail panel holding a stale id after a remove can
    // reach this. Returning a fresh object with the edit dropped would re-render
    // the canvas and snap the field back with nothing to explain it.
    const source = graphFromDraft(draft({ conditions: [STATUS_IN] }));
    const triggerId = nodeAt(source, 0).id;
    const conditionId = nodeAt(source, 1).id;
    const actionId = nodeAt(source, 2).id;

    expect(updateTriggerNode(source, conditionId, SLA_BREACHED)).toBe(source);
    expect(updateConditionNode(source, actionId, OUT_OF_HOURS)).toBe(source);
    expect(updateActionNode(source, triggerId, ADD_TAG)).toBe(source);
  });

  it('returns the graph unchanged when an update names an id that is gone', () => {
    const source = graphFromDraft(draft());

    expect(updateTriggerNode(source, 'gone', SLA_BREACHED)).toBe(source);
    expect(updateConditionNode(source, 'gone', OUT_OF_HOURS)).toBe(source);
    expect(updateActionNode(source, 'gone', ADD_TAG)).toBe(source);
  });

  it('moves by an index within the kind, not by a position on the canvas', () => {
    // Canvas position 1 in this graph is "just under the trigger", which for an
    // action is `indexWithinKind` 0. The two differ whenever conditions exist,
    // and the caller is the one that converts.
    const source = graphFromDraft(
      draft({
        conditions: [STATUS_IN, OLDER_THAN],
        actions: [ADD_TAG, SET_PENDING, SET_URGENT],
      }),
    );
    const moved = moveNode(source, kindAt(source, 'action', 2).id, 1);

    expect(readBack(moved).actions).toEqual([ADD_TAG, SET_URGENT, SET_PENDING]);
  });

  it('keeps the chain readable through a long editing session', () => {
    let graph = graphFromDraft(draft({ actions: [SET_PENDING] }));

    graph = insertCondition(graph, STATUS_IN, 0);
    graph = insertCondition(graph, TICKET_TAGGED, 0);
    graph = insertAction(graph, ADD_TAG, 0);
    graph = removeNode(graph, kindAt(graph, 'condition', 0).id);
    graph = moveNode(graph, kindAt(graph, 'action', 0).id, 1);
    graph = insertAction(graph, NOTIFY_USER, 1);

    const read = readBack(graph);

    expect(read.conditions).toEqual([STATUS_IN]);
    expect(read.actions).toEqual([SET_PENDING, NOTIFY_USER, ADD_TAG]);
    expect(graph.edges).toHaveLength(graph.nodes.length - 1);
  });
});

/** A workflow as the API returns one, so the round trip starts where a load does. */
function savedWorkflow(): WorkflowResponse {
  return {
    id: '0192f00c-0000-7000-8000-000000000c01',
    name: 'Escalate stale tickets',
    position: 0,
    isActive: true,
    brokenReason: null,
    version: 3,
    trigger: { type: 'ticket_unresolved_for', minutes: 90 },
    conditions: [STATUS_IN, ASSIGNED_TO_TEAM, OUT_OF_HOURS],
    actions: [ADD_TAG, NOTIFY_TEAM, SET_URGENT],
    references: [
      { kind: 'tag', id: TAG_ID, name: 'Escalated', exists: true },
      { kind: 'tag', id: OTHER_TAG_ID, name: 'VIP', exists: true },
      { kind: 'team', id: TEAM_ID, name: 'Support', exists: true },
      { kind: 'team', id: OTHER_TEAM_ID, name: 'Billing', exists: false },
    ],
    createdAt: '2026-01-05T09:00:00.000Z',
    updatedAt: '2026-02-11T14:30:00.000Z',
  };
}

/**
 * Indexing under `noUncheckedIndexedAccess`, failing with the index rather than
 * with `Cannot read properties of undefined` so a broken chain names itself.
 */
function nodeAt(graph: WorkflowGraph, index: number): WorkflowGraphNode {
  const node = graph.nodes[index];

  if (node === undefined) {
    throw new Error(`expected a node at ${String(index)}, found ${String(graph.nodes.length)}`);
  }

  return node;
}

/** The same, for the nth node of one kind. */
function kindAt(graph: WorkflowGraph, kind: WorkflowNodeKind, index: number): WorkflowGraphNode {
  const node = nodesOfKind(graph, kind)[index];

  if (node === undefined) {
    throw new Error(`expected a ${kind} at ${String(index)}`);
  }

  return node;
}

function describeCase(value: WorkflowCondition | WorkflowAction): string {
  if (value.type === 'ticket_assignment') {
    return `${value.type} (${value.state})`;
  }

  if (value.type === 'notify') {
    return `${value.type} (${value.audience})`;
  }

  if (value.type === 'reassign') {
    return `${value.type} (${value.target.kind})`;
  }

  return value.type;
}

import { describe, expect, it } from 'vitest';
import {
  WorkflowCreateInputSchema,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowReference,
  type WorkflowResponse,
  type WorkflowTestResponse,
  type WorkflowTrigger,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import {
  NODE_GAP,
  NODE_HEIGHT,
  TRIGGER_NODE_ID,
  actionNodeId,
  addAction,
  addCondition,
  conditionNodeId,
  dropIndex,
  layoutSpine,
  moveAction,
  nodeIdForPath,
  parseNodeId,
  removeNode,
  replaceNode,
  toGraph,
  type WorkflowGraph,
  type WorkflowGraphAnnotations,
  type WorkflowNodeId,
} from './graph';
import { EMPTY_WORKFLOW_VOCABULARY, type WorkflowVocabulary } from './presentation';
import {
  NO_WORKFLOW_ERRORS,
  draftFromWorkflow,
  validateWorkflowDraft,
  type WorkflowDraft,
} from './workflow-form';

/**
 * The canvas's projection and mutation layer, tested without a canvas.
 *
 * TAR-809's Phase A: "nothing about the canvas can be wrong in a way this phase
 * does not catch." Two things carry that. **No data loss** — a saved workflow
 * opened on the canvas and saved back unchanged produces the payload it already
 * had, which is TAR-812's fourth acceptance criterion and is a statement about
 * pure functions, not about pixels. **Annotations land on the right node** —
 * every one of them keys on a positional index, so an off-by-one would put a
 * supervisor's error message on the wrong step.
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

const VOCABULARY: WorkflowVocabulary = {
  teams: [],
  users: [],
  tags: [
    { id: TAG_ID, name: 'Escalated', color: '#aa0000' },
    { id: OTHER_TAG_ID, name: 'VIP', color: '#00aa00' },
  ],
};

function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    name: 'Escalate stale tickets',
    trigger: CREATED,
    conditions: [],
    actions: [{ type: 'set_priority', priority: 'high' }],
    isActive: false,
    ...overrides,
  };
}

function annotations(overrides: Partial<WorkflowGraphAnnotations> = {}): WorkflowGraphAnnotations {
  return {
    errors: NO_WORKFLOW_ERRORS,
    references: [],
    test: null,
    vocabulary: EMPTY_WORKFLOW_VOCABULARY,
    content,
    ...overrides,
  };
}

function graphOf(source: WorkflowDraft, overrides: Partial<WorkflowGraphAnnotations> = {}) {
  return toGraph(source, annotations(overrides));
}

function nodeById(graph: WorkflowGraph, id: WorkflowNodeId) {
  const node = graph.nodes.find((candidate) => candidate.id === id);

  if (node === undefined) {
    throw new Error(`no node ${id}`);
  }

  return node;
}

describe('toGraph', () => {
  it('lays the draft out as trigger → conditions → actions, in that order', () => {
    const graph = graphOf(
      draft({ conditions: [STATUS_IN, OLDER_THAN], actions: [ADD_TAG, SET_PENDING] }),
    );

    expect(graph.nodes.map((node) => node.id)).toEqual([
      TRIGGER_NODE_ID,
      'condition:0',
      'condition:1',
      'action:0',
      'action:1',
    ]);
  });

  it('gives every node the index it stands for, and the trigger none', () => {
    const graph = graphOf(draft({ conditions: [STATUS_IN], actions: [ADD_TAG, SET_PENDING] }));

    expect(graph.nodes.map((node) => [node.kind, node.index])).toEqual([
      ['trigger', null],
      ['condition', 0],
      ['action', 0],
      ['action', 1],
    ]);
  });

  it('joins every adjacent pair with exactly one edge', () => {
    const graph = graphOf(draft({ conditions: [STATUS_IN], actions: [ADD_TAG, SET_PENDING] }));

    expect(graph.edges).toEqual([
      { id: 'trigger->condition:0', source: 'trigger', target: 'condition:0' },
      { id: 'condition:0->action:0', source: 'condition:0', target: 'action:0' },
      { id: 'action:0->action:1', source: 'action:0', target: 'action:1' },
    ]);
  });

  it('wires the trigger straight to the first action when there are no conditions', () => {
    // Empty is legal and common — "every time this trigger fires, do this"
    // (0009 decision 4). The canvas must not invent a placeholder node for it.
    const graph = graphOf(draft());

    expect(graph.nodes.map((node) => node.id)).toEqual([TRIGGER_NODE_ID, 'action:0']);
    expect(graph.edges).toHaveLength(1);
  });

  it('is a pure function of its arguments, so server and client build the same graph', () => {
    // The hydration guarantee, pinned. A `crypto.randomUUID()` or a module-scope
    // counter would pass every other test here and mismatch on first paint.
    const source = draft({ conditions: [UNASSIGNED], actions: [NOTIFY_SUPERVISORS] });

    expect(graphOf(source)).toEqual(graphOf(source));
  });

  it('stacks the spine down one column at the node pitch', () => {
    const graph = graphOf(draft({ conditions: [STATUS_IN], actions: [ADD_TAG] }));

    expect(graph.nodes.map((node) => node.position)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: NODE_HEIGHT + NODE_GAP },
      { x: 0, y: 2 * (NODE_HEIGHT + NODE_GAP) },
    ]);
  });

  it('summarises every node through presentation.ts', () => {
    const graph = graphOf(draft({ conditions: [OUT_OF_HOURS], actions: [SET_PENDING] }));

    for (const node of graph.nodes) {
      expect(node.summary).not.toBe('');
    }

    expect(nodeById(graph, TRIGGER_NODE_ID).summary).toBe(content.workflows.summaryTriggerCreated);
  });

  it('leaves a clean draft with no error, no badge and no test result', () => {
    const graph = graphOf(draft({ conditions: [STATUS_IN] }));

    for (const node of graph.nodes) {
      expect(node.error).toBeNull();
      expect(node.brokenReferences).toEqual([]);
      expect(node.testResult).toBeNull();
    }
  });
});

describe('toGraph — annotations land on the right node', () => {
  it('puts each validation message on the node its index names', () => {
    // The reason positional identity was the right call: `byCondition` and
    // `byAction` are index-keyed, so this is a lookup rather than a translation.
    const source = draft({
      conditions: [STATUS_IN, OLDER_THAN],
      actions: [ADD_TAG, SET_PENDING],
    });
    const graph = graphOf(source, {
      errors: {
        ...NO_WORKFLOW_ERRORS,
        trigger: 'trigger is wrong',
        byCondition: { 1: 'second condition is wrong' },
        byAction: { 0: 'first action is wrong' },
      },
    });

    expect(nodeById(graph, TRIGGER_NODE_ID).error).toBe('trigger is wrong');
    expect(nodeById(graph, 'condition:0').error).toBeNull();
    expect(nodeById(graph, 'condition:1').error).toBe('second condition is wrong');
    expect(nodeById(graph, 'action:0').error).toBe('first action is wrong');
    expect(nodeById(graph, 'action:1').error).toBeNull();
  });

  it('badges only the nodes that name a reference which no longer resolves', () => {
    const gone: WorkflowReference = { kind: 'team', id: OTHER_TEAM_ID, name: null, exists: false };
    const source = draft({
      conditions: [ASSIGNED_TO_TEAM, OUT_OF_HOURS],
      actions: [{ type: 'reassign', target: { kind: 'team', teamId: OTHER_TEAM_ID } }],
    });
    const graph = graphOf(source, {
      references: [{ kind: 'team', id: TEAM_ID, name: 'Support', exists: true }, gone],
    });

    expect(nodeById(graph, 'condition:0').brokenReferences).toEqual([]);
    expect(nodeById(graph, 'condition:1').brokenReferences).toEqual([]);
    expect(nodeById(graph, 'action:0').brokenReferences).toEqual([gone]);
  });

  it('counts two missing ids named by one node', () => {
    const goneTag: WorkflowReference = { kind: 'tag', id: TAG_ID, name: null, exists: false };
    const goneOther: WorkflowReference = {
      kind: 'tag',
      id: OTHER_TAG_ID,
      name: null,
      exists: false,
    };
    const graph = graphOf(draft({ conditions: [TICKET_TAGGED] }), {
      references: [goneTag, goneOther],
    });

    expect(nodeById(graph, 'condition:0').brokenReferences).toEqual([goneTag, goneOther]);
  });

  it('puts each dry-run outcome on the node its index names', () => {
    const test: WorkflowTestResponse = {
      matched: true,
      conditions: [
        { index: 0, type: 'ticket_status', held: true, reason: null },
        { index: 1, type: 'business_hours', held: false, reason: 'business_hours_unconfigured' },
      ],
      actions: [{ index: 0, type: 'set_status', outcome: 'applied', describes: 'Set to pending' }],
    };
    const graph = graphOf(
      draft({ conditions: [STATUS_IN, OUT_OF_HOURS], actions: [SET_PENDING] }),
      { test },
    );

    expect(nodeById(graph, 'condition:0').testResult).toEqual({
      kind: 'condition',
      held: true,
      reason: null,
    });
    expect(nodeById(graph, 'condition:1').testResult).toEqual({
      kind: 'condition',
      held: false,
      reason: 'business_hours_unconfigured',
    });
    expect(nodeById(graph, 'action:0').testResult).toEqual({
      kind: 'action',
      outcome: 'applied',
      describes: 'Set to pending',
    });
  });

  it('leaves an unreported node without a test result rather than guessing', () => {
    // `WorkflowTestResponse.actions` is empty when the workflow did not match, so
    // "no entry" is a real and common case, not a malformed response.
    const test: WorkflowTestResponse = {
      matched: false,
      conditions: [{ index: 0, type: 'ticket_status', held: false, reason: null }],
      actions: [],
    };
    const graph = graphOf(draft({ conditions: [STATUS_IN], actions: [SET_PENDING] }), { test });

    expect(nodeById(graph, 'action:0').testResult).toBeNull();
  });
});

describe('no data loss', () => {
  it.each(ALL_TRIGGERS.map((trigger) => [trigger.type, trigger] as const))(
    'renders a %s trigger without disturbing the draft',
    (_type, trigger) => {
      const source = draft({ trigger });

      graphOf(source);

      expect(source.trigger).toEqual(trigger);
    },
  );

  it.each(ALL_CONDITIONS.map((condition) => [describeCase(condition), condition] as const))(
    'renders a %s condition as exactly one node',
    (_label, condition) => {
      const graph = graphOf(draft({ conditions: [condition] }));

      expect(nodeById(graph, 'condition:0').index).toBe(0);
      expect(graph.nodes.filter((node) => node.kind === 'condition')).toHaveLength(1);
    },
  );

  it.each(ALL_ACTIONS.map((action) => [describeCase(action), action] as const))(
    'renders a %s action as exactly one node',
    (_label, action) => {
      const graph = graphOf(draft({ actions: [action] }));

      expect(nodeById(graph, 'action:0').index).toBe(0);
      expect(graph.nodes.filter((node) => node.kind === 'action')).toHaveLength(1);
    },
  );

  it('gives the widest workflow the caps allow one node per element', () => {
    // The caps are 10 conditions and 5 actions; this is 9 and 5.
    const source = draft({
      trigger: { type: 'ticket_unresolved_for', minutes: 43_200 },
      conditions: [...ALL_CONDITIONS],
      actions: ALL_ACTIONS.slice(0, 5),
    });
    const graph = graphOf(source);

    expect(graph.nodes).toHaveLength(1 + ALL_CONDITIONS.length + 5);
    expect(graph.edges).toHaveLength(graph.nodes.length - 1);
  });

  it('carries a saved workflow to the same API payload it already had', () => {
    // TAR-812's fourth acceptance criterion, end to end: an existing workflow,
    // opened on the canvas, changed in no way, and submitted through the same
    // `validateWorkflowDraft` the form dialogs use.
    const workflow = savedWorkflow();
    const opened = draftFromWorkflow(workflow);

    graphOf(opened, { references: workflow.references });

    const saved = validateWorkflowDraft(opened, content);

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

  it('never lets the canvas re-arm a workflow the list switched off', () => {
    // `isActive` is not on the canvas at all (TAR-809 — the mapping table), so
    // there is no node a supervisor could nudge that would change it, and no
    // mutation here writes it.
    const source = draft({ isActive: false });
    const edited = moveAction(addCondition(source, 'business_hours'), 0, 0);

    expect(edited.isActive).toBe(false);
  });
});

describe('mutations', () => {
  it('appends a blank condition from builder.ts', () => {
    const edited = addCondition(draft(), 'ticket_status');

    expect(edited.conditions).toEqual([{ type: 'ticket_status', operator: 'in', values: [] }]);
  });

  it('appends a blank action from builder.ts', () => {
    const edited = addAction(draft({ actions: [] }), 'add_ticket_tag', VOCABULARY);

    expect(edited.actions).toEqual([{ type: 'add_ticket_tag', tagId: TAG_ID }]);
  });

  it('removes the condition a node stands for and renumbers the rest', () => {
    const source = draft({ conditions: [STATUS_IN, OLDER_THAN, OUT_OF_HOURS] });
    const edited = removeNode(source, conditionNodeId(1));

    expect(edited.conditions).toEqual([STATUS_IN, OUT_OF_HOURS]);
    expect(nodeById(graphOf(edited), 'condition:1').summary).toBe(
      nodeById(graphOf(source), 'condition:2').summary,
    );
  });

  it('removes the action a node stands for', () => {
    const source = draft({ actions: [ADD_TAG, SET_PENDING, SET_URGENT] });

    expect(removeNode(source, actionNodeId(0)).actions).toEqual([SET_PENDING, SET_URGENT]);
  });

  it('refuses to remove the trigger', () => {
    const source = draft();

    expect(removeNode(source, TRIGGER_NODE_ID)).toBe(source);
  });

  it('ignores a remove for an index that is already gone', () => {
    const source = draft({ conditions: [STATUS_IN] });

    expect(removeNode(source, conditionNodeId(4))).toBe(source);
  });

  it('replaces what each kind of node holds', () => {
    const source = draft({ conditions: [STATUS_IN], actions: [ADD_TAG] });

    expect(replaceNode(source, TRIGGER_NODE_ID, UNRESOLVED_FOR).trigger).toEqual(UNRESOLVED_FOR);
    expect(replaceNode(source, conditionNodeId(0), OUT_OF_HOURS).conditions).toEqual([
      OUT_OF_HOURS,
    ]);
    expect(replaceNode(source, actionNodeId(0), SET_URGENT).actions).toEqual([SET_URGENT]);
  });

  it('returns the draft unchanged when the value is the wrong kind for the node', () => {
    // The three `type` vocabularies are disjoint, so this is detectable here
    // rather than at the API's refusal. A stale id from a detail panel is the
    // realistic path, and a half-applied edit would be worse than none.
    const source = draft({ conditions: [STATUS_IN], actions: [ADD_TAG] });

    expect(replaceNode(source, TRIGGER_NODE_ID, OUT_OF_HOURS)).toBe(source);
    expect(replaceNode(source, conditionNodeId(0), SET_URGENT)).toBe(source);
    expect(replaceNode(source, actionNodeId(0), CREATED)).toBe(source);
  });

  it('returns the draft unchanged when the index is past the end', () => {
    const source = draft({ conditions: [STATUS_IN] });

    expect(replaceNode(source, conditionNodeId(9), OUT_OF_HOURS)).toBe(source);
    expect(replaceNode(source, actionNodeId(9), SET_URGENT)).toBe(source);
  });

  it('reorders actions, which is execution order', () => {
    const source = draft({ actions: [ADD_TAG, SET_PENDING, SET_URGENT] });

    expect(moveAction(source, 2, 0).actions).toEqual([SET_URGENT, ADD_TAG, SET_PENDING]);
    expect(moveAction(source, 0, 2).actions).toEqual([SET_PENDING, SET_URGENT, ADD_TAG]);
  });

  it('clamps a move past the end and ignores one from nowhere', () => {
    const source = draft({ actions: [ADD_TAG, SET_PENDING] });

    expect(moveAction(source, 0, 9).actions).toEqual([SET_PENDING, ADD_TAG]);
    expect(moveAction(source, 5, 0)).toBe(source);
    expect(moveAction(source, 1, 1)).toBe(source);
  });

  it('leaves every other field of the draft alone', () => {
    const source = draft({ conditions: [STATUS_IN], actions: [ADD_TAG] });
    const edited = removeNode(addCondition(source, 'business_hours'), conditionNodeId(0));

    expect(edited.name).toBe(source.name);
    expect(edited.trigger).toEqual(source.trigger);
    expect(edited.actions).toEqual(source.actions);
  });

  it('keeps the draft valid through a long editing session', () => {
    let edited = draft({ actions: [SET_PENDING] });

    edited = addCondition(edited, 'ticket_status');
    edited = addCondition(edited, 'business_hours');
    edited = replaceNode(edited, conditionNodeId(0), STATUS_IN);
    edited = addAction(edited, 'set_priority', VOCABULARY);
    edited = moveAction(edited, 1, 0);
    edited = removeNode(edited, conditionNodeId(1));

    expect(edited.conditions).toEqual([STATUS_IN]);
    expect(edited.actions.map((action) => action.type)).toEqual(['set_priority', 'set_status']);
    expect(graphOf(edited).edges).toHaveLength(graphOf(edited).nodes.length - 1);
  });
});

describe('nodeIdForPath', () => {
  it('maps the contract`s reference paths to their nodes', () => {
    expect(nodeIdForPath('conditions.2.tagIds')).toBe('condition:2');
    expect(nodeIdForPath('conditions.0.teamId')).toBe('condition:0');
    expect(nodeIdForPath('actions.1.target.userId')).toBe('action:1');
    expect(nodeIdForPath('actions.0.tagId')).toBe('action:0');
  });

  it('returns null for a path that names no node', () => {
    // Highlighting the wrong node is worse than highlighting none, so anything
    // unrecognised — a field on the workflow itself, a shape a future endpoint
    // invents — declines rather than guesses.
    expect(nodeIdForPath('name')).toBeNull();
    expect(nodeIdForPath('trigger.minutes')).toBeNull();
    expect(nodeIdForPath('conditions')).toBeNull();
    expect(nodeIdForPath('conditions.x.tagIds')).toBeNull();
    expect(nodeIdForPath('conditions.-1.tagIds')).toBeNull();
    expect(nodeIdForPath('')).toBeNull();
  });

  it('agrees with the ids toGraph mints, which is the whole point', () => {
    const graph = graphOf(draft({ conditions: [ASSIGNED_TO_TEAM], actions: [ADD_TAG] }));

    expect(nodeById(graph, nodeIdForPath('conditions.0.teamId') ?? TRIGGER_NODE_ID).kind).toBe(
      'condition',
    );
    expect(nodeById(graph, nodeIdForPath('actions.0.tagId') ?? TRIGGER_NODE_ID).kind).toBe(
      'action',
    );
  });
});

describe('parseNodeId', () => {
  it('round-trips every id toGraph produces', () => {
    expect(parseNodeId(TRIGGER_NODE_ID)).toEqual({ kind: 'trigger', index: null });
    expect(parseNodeId(conditionNodeId(3))).toEqual({ kind: 'condition', index: 3 });
    expect(parseNodeId(actionNodeId(0))).toEqual({ kind: 'action', index: 0 });
  });
});

describe('layout', () => {
  it('stacks n nodes down one column and nothing across', () => {
    expect(layoutSpine(3)).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: NODE_HEIGHT + NODE_GAP },
      { x: 0, y: 2 * (NODE_HEIGHT + NODE_GAP) },
    ]);
  });

  it('returns nothing for an empty or negative count rather than throwing', () => {
    expect(layoutSpine(0)).toEqual([]);
    expect(layoutSpine(-1)).toEqual([]);
  });

  it('turns a drop position back into the slot it is nearest', () => {
    const pitch = NODE_HEIGHT + NODE_GAP;

    expect(dropIndex(0, 3)).toBe(0);
    expect(dropIndex(pitch, 3)).toBe(1);
    expect(dropIndex(2 * pitch, 3)).toBe(2);
    // Past halfway into the next slot, the node moves — which is what the
    // gesture looks like it should do.
    expect(dropIndex(pitch * 0.6, 3)).toBe(1);
    expect(dropIndex(pitch * 0.4, 3)).toBe(0);
  });

  it('clamps a drop outside the action band and copes with an empty one', () => {
    expect(dropIndex(-500, 3)).toBe(0);
    expect(dropIndex(9_000, 3)).toBe(2);
    expect(dropIndex(120, 0)).toBe(0);
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

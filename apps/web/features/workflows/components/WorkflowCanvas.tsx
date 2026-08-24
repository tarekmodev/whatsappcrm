'use client';

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ViewportPortal,
  applyNodeChanges,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import { useContent } from '@/lib/content';
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  actionBandOrigin,
  conditionBandBox,
  dropIndex,
  parseNodeId,
  type WorkflowGraph,
  type WorkflowGraphNode,
  type WorkflowNodeId,
} from '../graph';
import { WorkflowNodeCard } from './WorkflowNodeCard';
import '@xyflow/react/dist/base.css';
import styles from './WorkflowCanvas.module.css';

/**
 * The workflow spine, rendered. Usage: never directly — always through
 * `LazyWorkflowCanvas` in `workflow-canvas.lazy.tsx`, which pairs it with its
 * skeleton and keeps its chunk off every other route.
 *
 * **This is the only module in the app that imports `@xyflow/react`**, and the
 * containment is enforced by an ESLint `no-restricted-imports` entry rather than
 * left to discipline: a static import anywhere else would put ~59 KB gzipped on
 * every console route (TAR-809, Decision 1).
 *
 * ## The draft is the state; this draws a picture of it
 *
 * Every node position comes from `layoutSpine`, recomputed from the draft on
 * every render, and nothing here is ever persisted (TAR-809 decision 3). Local
 * state holds exactly one thing: where a node is *while it is being dragged*.
 * On drop, `onMoveAction` reorders the draft and the projection puts the node in
 * its computed slot — the drag communicates intent, it never sets a coordinate.
 *
 * ## What is deliberately switched off
 *
 * Connecting, reconnecting and node focus. The grammar has no edges to author
 * (one trigger, an AND-list, an ordered action list), so a connectable handle
 * could only ever express something the API refuses. Node focus is the library's
 * and would sit *beside* the card's own button, giving every step two tab stops
 * for one thing; `WorkflowNodeCard` is the focusable element.
 */

export interface WorkflowCanvasProps {
  graph: WorkflowGraph;
  selectedNodeId: WorkflowNodeId | null;
  /** Read-only for a principal holding `workflow:read` without `workflow:write`. */
  canWrite: boolean;
  conditionCount: number;
  actionCount: number;
  onSelect: (id: WorkflowNodeId) => void;
  onMoveAction: (from: number, to: number) => void;
}

type WorkflowStepData = {
  node: WorkflowGraphNode;
  isSelected: boolean;
  onSelect: () => void;
};

type WorkflowStepNode = Node<WorkflowStepData, 'workflowStep'>;

/**
 * Module scope, not inline. React Flow re-creates its whole node renderer when
 * this object's identity changes, so an inline literal would remount every node
 * on every render — the library warns about exactly this.
 */
const NODE_TYPES: NodeTypes = { workflowStep: WorkflowStepNodeView };

/** No watermark. MIT permits hiding it; see TAR-809 open question 1. */
const PRO_OPTIONS = { hideAttribution: true };

const FIT_VIEW_OPTIONS = { maxZoom: 1, padding: 0.2 };

export function WorkflowCanvas({
  graph,
  selectedNodeId,
  canWrite,
  conditionCount,
  actionCount,
  onSelect,
  onMoveAction,
}: WorkflowCanvasProps) {
  const content = useContent();
  const copy = content.workflows;
  const [nodes, setNodes] = useState<WorkflowStepNode[]>(() =>
    toFlowNodes(graph, selectedNodeId, canWrite, onSelect),
  );

  // The projection changed — a step was added, edited, removed or reordered — so
  // every position goes back to what `layoutSpine` says it is. This is also what
  // snaps a dragged node home when the drop did not change the order.
  useEffect(() => {
    setNodes(toFlowNodes(graph, selectedNodeId, canWrite, onSelect));
  }, [graph, selectedNodeId, canWrite, onSelect]);

  const handleNodesChange = useCallback((changes: NodeChange<WorkflowStepNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleDragStop = useCallback(
    (_event: unknown, node: WorkflowStepNode) => {
      const parsed = parseNodeId(node.id as WorkflowNodeId);

      if (parsed === null || parsed.kind !== 'action') {
        return;
      }

      // `dropIndex` measures from the first action's slot, because only the
      // canvas knows how many condition nodes sit above it.
      onMoveAction(
        parsed.index,
        dropIndex(node.position.y - actionBandOrigin(conditionCount), actionCount),
      );

      // Unconditionally, rather than trusting the projection to run: a drop that
      // lands on the index it started from leaves the draft untouched, and
      // without this the node would stay where the pointer left it.
      setNodes(toFlowNodes(graph, selectedNodeId, canWrite, onSelect));
    },
    [actionCount, canWrite, conditionCount, graph, onMoveAction, onSelect, selectedNodeId],
  );

  const band = conditionBandBox(conditionCount);

  return (
    <div
      className={styles.viewport}
      /*
       * React Flow's viewport transform is not `dir`-aware, so the canvas keeps
       * LTR maths under an Arabic page and the *content* of each node inherits
       * direction from the document (TAR-809 decision 4). A vertical spine is
       * direction-neutral, so nothing else has to be mirrored.
       */
      dir="ltr"
      style={
        {
          '--node-width': `${String(NODE_WIDTH)}px`,
          '--node-height': `${String(NODE_HEIGHT)}px`,
        } as CSSProperties
      }
    >
      <ReactFlow<WorkflowStepNode>
        nodes={nodes}
        edges={graph.edges.map((edge) => ({ ...edge, selectable: false, focusable: false }))}
        nodeTypes={NODE_TYPES}
        onNodesChange={handleNodesChange}
        onNodeDragStop={handleDragStop}
        proOptions={PRO_OPTIONS}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        nodesConnectable={false}
        edgesReconnectable={false}
        elementsSelectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        /*
         * The page keeps its scroll. A settings screen whose middle third
         * swallowed the wheel would trap anyone scrolling past it; zoom is on the
         * Controls buttons — which are real buttons, so it is reachable from the
         * keyboard too — and on pinch.
         */
        zoomOnScroll={false}
        preventScrolling={false}
        aria-label={copy.canvasLabel}
      >
        <Background variant={BackgroundVariant.Dots} gap={NODE_HEIGHT / 4} size={1} />
        <Controls showInteractive={false} />

        {band === null ? null : (
          <ViewportPortal>
            <div
              className={styles.conditionBand}
              aria-hidden="true"
              style={
                {
                  '--band-x': `${String(band.x)}px`,
                  '--band-y': `${String(band.y)}px`,
                  '--band-width': `${String(band.width)}px`,
                  '--band-height': `${String(band.height)}px`,
                } as CSSProperties
              }
            >
              <span className={styles.conditionBandLabel}>{copy.conditionBandLabel}</span>
            </div>
          </ViewportPortal>
        )}
      </ReactFlow>
    </div>
  );
}

/** The library's node contract, satisfied by a component that knows none of it. */
function WorkflowStepNodeView({ data }: NodeProps<WorkflowStepNode>) {
  return (
    <>
      <Handle
        className={styles.handle}
        type="target"
        position={Position.Top}
        isConnectable={false}
      />
      <WorkflowNodeCard node={data.node} isSelected={data.isSelected} onSelect={data.onSelect} />
      <Handle
        className={styles.handle}
        type="source"
        position={Position.Bottom}
        isConnectable={false}
      />
    </>
  );
}

function toFlowNodes(
  graph: WorkflowGraph,
  selectedNodeId: WorkflowNodeId | null,
  canWrite: boolean,
  onSelect: (id: WorkflowNodeId) => void,
): WorkflowStepNode[] {
  return graph.nodes.map((node) => ({
    id: node.id,
    type: 'workflowStep',
    position: { ...node.position },
    // Only actions move, and only for somebody who may save the result: action
    // order is execution order, while reordering an AND changes nothing a
    // supervisor could observe (ADR 0009 decision 5).
    draggable: canWrite && node.kind === 'action',
    selectable: false,
    focusable: false,
    data: {
      node,
      isSelected: node.id === selectedNodeId,
      onSelect: () => {
        onSelect(node.id);
      },
    },
  }));
}

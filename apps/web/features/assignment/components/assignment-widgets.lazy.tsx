'use client';

import dynamic from 'next/dynamic';
import { AgentLoadTableSkeleton } from './AgentLoadTable';
import { TeamLoadTableSkeleton } from './TeamLoadTable';

/**
 * The two workload tables, split into their own chunks.
 *
 * They sit below the fold on every viewport this app supports and are not the LCP
 * element, so their JavaScript has no business in the initial route bundle. Each
 * boundary's fallback is that table's own skeleton, sized identically, so
 * deferring the chunk cannot shift the layout.
 *
 * SSR stays on: these are reporting figures a supervisor should see in the first
 * HTML response, and turning it off would blank the section until hydration.
 */

export const LazyAgentLoadTable = dynamic(
  async () => (await import('./AgentLoadTable')).AgentLoadTable,
  { loading: () => <AgentLoadTableSkeleton /> },
);

export const LazyTeamLoadTable = dynamic(
  async () => (await import('./TeamLoadTable')).TeamLoadTable,
  { loading: () => <TeamLoadTableSkeleton /> },
);

'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * The routing-rule dialog chunks, loaded on first open rather than with the page.
 *
 * `RuleFormDialog` is the heaviest widget on this surface — four condition
 * editors, the target picker and the whole validation module — and none of it is
 * needed to *read* the rule list. Keeping it behind a boundary is what stops a
 * supervisor who only wanted to check the order from downloading the builder.
 *
 * `ssr: false` because a dialog only ever mounts in response to a click: there is
 * no server render of it to be had, and no indexable content inside it. The
 * `loading` fallback is the shared dialog skeleton, sized like the panel it stands
 * in for, so opening one never flashes an empty sheet.
 */

export const LazyRuleFormDialog = dynamic(
  async () => (await import('./RuleFormDialog')).RuleFormDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

export const LazyDeleteRuleDialog = dynamic(
  async () => (await import('./DeleteRuleDialog')).DeleteRuleDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

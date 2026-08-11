'use client';

import dynamic from 'next/dynamic';
import { DialogSkeleton } from '@/components/ui/DialogSkeleton';

/**
 * Dialog chunks for the inbox, loaded on first open rather than with the page.
 *
 * The inbox is the app's busiest route and a take-over confirmation is opened by
 * a minority of readers on a minority of threads, so it has no business in the
 * route's initial JavaScript. `ssr: false` because a dialog only ever mounts in
 * response to a click — there is no server render of it to be had.
 */
export const LazyTakeOverDialog = dynamic(
  async () => (await import('./TakeOverDialog')).TakeOverDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

/**
 * The template picker (TAR-20g), and the larger of the two by some way — it
 * pulls in the send form, the header fields and the media upload behind it.
 *
 * Most replies are free-form, so none of that belongs in the inbox's initial
 * JavaScript. The chunk arrives when an agent first reaches for a template,
 * which is also the moment the templates themselves are fetched.
 */
export const LazyTemplatePickerDialog = dynamic(
  async () => (await import('./TemplatePickerDialog')).TemplatePickerDialog,
  { ssr: false, loading: () => <DialogSkeleton /> },
);

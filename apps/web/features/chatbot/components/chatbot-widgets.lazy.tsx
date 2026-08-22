'use client';

import dynamic from 'next/dynamic';
import { AiConfigFormSkeleton } from './AiConfigForm.Skeleton';

/**
 * The settings form, loaded behind its own boundary.
 *
 * It is the only interactive widget on this page that a reader does not need to
 * *see* the chatbot's state: the readiness panel above it and the knowledge base
 * below it both render on the server. Splitting it keeps seven controls, the
 * slider and the validation module out of the initial load for an admin who came
 * to check whether the bot is answering.
 *
 * The fallback is the form's own skeleton, sized identically, so the swap
 * produces no layout shift. `LazyBoundary` supplies the Suspense and error
 * boundary around it.
 */
export const LazyAiConfigForm = dynamic(async () => (await import('./AiConfigForm')).AiConfigForm, {
  loading: () => <AiConfigFormSkeleton />,
});

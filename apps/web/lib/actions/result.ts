/**
 * The shape every server action in the app returns.
 *
 * A discriminated union rather than a thrown error, so a form can render an
 * inline message and keep the user's input — a thrown server action unmounts into
 * the route's error boundary and loses the whole form.
 *
 * Lives in `lib/` rather than in a feature because the shared `useActionForm`
 * hook consumes it, and a primitive must never import from a feature.
 */
export type ActionResult<T = undefined> =
  { status: 'success'; data: T } | { status: 'error'; message: string; requestId: string | null };

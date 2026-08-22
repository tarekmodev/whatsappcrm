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
  | { status: 'success'; data: T }
  | {
      status: 'error';
      message: string;
      requestId: string | null;
      /**
       * The API's machine-readable error code, when the failure came from the
       * API at all — absent for a client-side validation failure or a refusal
       * the action made itself.
       *
       * Optional, and deliberately so: a form that only shows `message` needs no
       * change, and most of them never will. It exists for the one thing copy
       * cannot do — offer a *different affordance* for a specific refusal. The
       * seat cap is the case that earned it (TAR-37): `plan_limit_exceeded` on
       * an invitation means an upgrade link belongs in the dialog, and the code
       * is how the dialog knows that without matching on the message text, which
       * is server-owned copy and would break the moment it was reworded or
       * translated.
       */
      code?: string;
    };

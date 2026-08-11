'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectedWhatsAppBusinessAccountResponse } from '@whatsappcrm/contracts';
import { webEnv } from '@/lib/config/env';
import {
  CANCEL_EVENT,
  ERROR_EVENT,
  embeddedSignupLoginOptions,
  parseEmbeddedSignupMessage,
  type EmbeddedSignupMessage,
} from './embedded-signup';
import {
  connectFailure,
  connectFailureFromError,
  type WhatsAppConnectFailureReport,
} from './connect-failure';
import { connectWhatsAppAccountAction } from './whatsapp.actions';

/**
 * The Embedded Signup run, from the click to a connected account.
 *
 * ## Why the two halves are collected before anything is sent
 *
 * A run reports itself through two channels that Meta does not order: the
 * `postMessage` carries `waba_id`, and the `FB.login` callback carries the
 * authorisation code. Neither is enough on its own — the code says nothing about
 * which WABA it covers, and the message carries no credential — so both are held
 * in a ref and the request goes out the instant the second one lands, from
 * whichever handler that is.
 *
 * The alternative, waiting for the callback because it "usually" comes last, is a
 * bet against an ordering Meta never promised, and losing it costs the whole run:
 * the code is valid for about 30 seconds and cannot be re-requested.
 *
 * **There is nothing between the second half arriving and the request.** No
 * confirmation, no form, no navigation. That is the acceptance criterion, and it
 * is why the submit lives in a ref-driven handler rather than in an effect
 * watching state — a `setState` round trip is a render Meta's clock is running
 * through.
 *
 * ## Why a ref rather than state for the attempt
 *
 * The handlers are registered once and must see the *current* attempt, not the
 * one captured when they were created; and `isSettled` is read twice in the same
 * tick when a `CANCEL` chases a `FINISH`, which state cannot answer correctly.
 *
 * ## Every wait has an end
 *
 * The panel's only control is disabled while the flow is in progress, so a state
 * this hook can enter and never leave is a page with no way forward short of a
 * reload — which nobody thinks to do. Two waits could do that, and both are
 * bounded here rather than trusted:
 *
 *   - **the SDK arriving**, which `next/script` reports exactly once per page
 *     load and never again for a script it has already cached, so a return visit
 *     to this route gets no `onLoad` at all;
 *   - **the run itself**, which needs two messages Meta may only send one of.
 *
 * Neither timeout is a retry. They end a wait that has stopped being one and
 * hand the user back a button.
 */

/**
 * How long a run may sit with half of Meta's answer before it is called off.
 *
 * Generous on purpose: the user is inside Meta's own window for most of it,
 * choosing a business and a number, and cutting that short would abandon a run
 * that was going fine. This is the backstop for a `FINISH` that is never coming —
 * a message from a host outside the allow-list, an event Meta renamed, a privacy
 * extension that blocked the post — not a progress indicator.
 */
const ATTEMPT_TIMEOUT_MS = 5 * 60_000;

/**
 * How long to wait for Meta's script before saying it is not coming.
 *
 * Past this the button would be a spinner with nothing behind it, so the panel
 * switches to the blocked-script explanation instead. Recoverable rather than
 * final: a script that arrives late still runs `onLoad`, which puts the panel
 * back into working order.
 */
const SDK_READY_TIMEOUT_MS = 20_000;

export type EmbeddedSignupStatus = 'idle' | 'authorising' | 'connecting' | 'connected' | 'failed';

export type EmbeddedSignupState =
  | { readonly status: 'idle' }
  /** Meta's window is open. The wait is theirs, and the user is in it. */
  | { readonly status: 'authorising' }
  /** Meta answered; the exchange is in flight. The 30 seconds are running. */
  | { readonly status: 'connecting' }
  | {
      readonly status: 'connected';
      readonly account: ConnectedWhatsAppBusinessAccountResponse;
    }
  | { readonly status: 'failed'; readonly report: WhatsAppConnectFailureReport };

/** Whether Meta's script is usable yet. Separate from the run: it outlives one. */
export type MetaSdkStatus = 'loading' | 'ready' | 'unavailable';

export interface UseEmbeddedSignupOptions {
  onConnected: (account: ConnectedWhatsAppBusinessAccountResponse) => void;
}

export interface UseEmbeddedSignup {
  state: EmbeddedSignupState;
  sdkStatus: MetaSdkStatus;
  /** `false` when the console has no Meta app configured — no button to offer. */
  isConfigured: boolean;
  /** Called by `next/script` once Meta's SDK is on the page. */
  onSdkLoad: () => void;
  onSdkError: () => void;
  start: () => void;
}

interface Attempt {
  code: string | null;
  signup: EmbeddedSignupMessage | null;
  /** Set by whichever of submit or fail gets there first; the other stands down. */
  isSettled: boolean;
}

function freshAttempt(): Attempt {
  return { code: null, signup: null, isSettled: false };
}

export function useEmbeddedSignup({ onConnected }: UseEmbeddedSignupOptions): UseEmbeddedSignup {
  const [state, setState] = useState<EmbeddedSignupState>({ status: 'idle' });
  const [sdkStatus, setSdkStatus] = useState<MetaSdkStatus>('loading');
  const attemptRef = useRef<Attempt>(freshAttempt());
  const isMountedRef = useRef(true);
  const attemptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read inside handlers registered once; a ref keeps them from capturing a stale
  // callback without re-registering the window listener on every render.
  const onConnectedRef = useRef(onConnected);

  onConnectedRef.current = onConnected;

  const clearAttemptTimer = useCallback((): void => {
    if (attemptTimerRef.current !== null) {
      clearTimeout(attemptTimerRef.current);
      attemptTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      // Never leave a timer running past the panel: it would fire into a
      // component that no longer exists.
      clearAttemptTimer();
    };
  }, [clearAttemptTimer]);

  const settle = useCallback(
    (next: EmbeddedSignupState): void => {
      attemptRef.current.isSettled = true;
      clearAttemptTimer();

      if (isMountedRef.current) {
        setState(next);
      }
    },
    [clearAttemptTimer],
  );

  const fail = useCallback(
    (report: WhatsAppConnectFailureReport): void => {
      if (attemptRef.current.isSettled) {
        return;
      }

      settle({ status: 'failed', report });
    },
    [settle],
  );

  /**
   * Sends the moment both halves are in hand, and does nothing until then.
   *
   * Settles *before* awaiting, so a `CANCEL` arriving while the request is in
   * flight — Meta closes its window after `FINISH` — cannot replace a connection
   * in progress with "you cancelled", and so the run's watchdog stops before the
   * request it is no longer watching.
   */
  const submitIfReady = useCallback((): void => {
    const attempt = attemptRef.current;

    if (attempt.isSettled || attempt.code === null || attempt.signup === null) {
      return;
    }

    if (attempt.signup.wabaId === null) {
      // A completed run that named no business account. Nothing to send: the
      // request would be rejected after the code was already spent.
      fail(connectFailure('unknown'));
      return;
    }

    const input = {
      code: attempt.code,
      wabaId: attempt.signup.wabaId,
      ...(attempt.signup.phoneNumberId === null
        ? {}
        : { phoneNumberId: attempt.signup.phoneNumberId }),
    };

    settle({ status: 'connecting' });

    void connectWhatsAppAccountAction(input)
      .then((result) => {
        if (!isMountedRef.current) {
          return;
        }

        if (result.status === 'error') {
          setState({ status: 'failed', report: result.report });
          return;
        }

        setState({ status: 'connected', account: result.account });
        onConnectedRef.current(result.account);
      })
      .catch((error: unknown) => {
        // Reaches here only if the action itself could not run — a dropped
        // network, a chunk that would not load. Not swallowed.
        console.error('The WhatsApp connection request could not be sent', error);

        if (isMountedRef.current) {
          setState({ status: 'failed', report: connectFailureFromError(error) });
        }
      });
  }, [fail, settle]);

  /**
   * Registered once for the panel's lifetime rather than per run: Meta can post
   * its `FINISH` before `FB.login`'s callback returns, and a listener added inside
   * the click handler races that.
   */
  useEffect(() => {
    function handleMessage(message: MessageEvent): void {
      const parsed = parseEmbeddedSignupMessage(message);

      if (parsed === null) {
        return;
      }

      if (parsed.isCompletion) {
        attemptRef.current.signup = parsed;
        submitIfReady();
        return;
      }

      if (parsed.event === CANCEL_EVENT) {
        fail(connectFailure('cancelled'));
        return;
      }

      if (parsed.event === ERROR_EVENT) {
        fail(connectFailure('meta_error'));
      }

      // Any other event is one Meta added after this build. Ignored rather than
      // guessed at: the run is still live, and ending it would be wrong.
    }

    window.addEventListener('message', handleMessage);

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [fail, submitIfReady]);

  /**
   * Configures Meta's SDK and marks it usable, reporting whether it was there to
   * configure. Safe to call more than once — `FB.init` is idempotent, and this
   * has to be callable from both the load event and a plain mount.
   */
  const initialiseSdk = useCallback((): boolean => {
    const sdk = window.FB;

    if (sdk === undefined || webEnv.metaAppId === null) {
      return false;
    }

    sdk.init({
      appId: webEnv.metaAppId,
      autoLogAppEvents: true,
      // No `<fb:*>` tags on this page, and parsing the DOM for them is work with
      // nothing to find.
      xfbml: false,
      version: webEnv.metaGraphApiVersion,
    });

    setSdkStatus('ready');

    return true;
  }, []);

  /**
   * Readiness is a fact about `window.FB`, not about the load event.
   *
   * `next/script` fires `onLoad` once per page load: it keeps a module-level
   * cache of scripts it has already inserted, so the second time this panel
   * mounts in the same session — an admin visiting Settings → People and coming
   * back — the script is not re-inserted and no callback runs. Deriving readiness
   * from the load event alone left `sdkStatus` at `'loading'` for the rest of
   * that session, which disabled the page's only button with no way back short of
   * a full reload.
   *
   * So the mount asks the SDK directly. `onReady` would cover the same remount,
   * but only for as long as Next keeps calling it; `window.FB` being present is
   * the thing that actually decides whether `FB.login` can run.
   *
   * `false` here is the ordinary first visit — the script has not arrived yet —
   * and is not a failure. The timeout below is what turns "not yet" into an
   * answer.
   */
  useEffect(() => {
    if (initialiseSdk()) {
      return;
    }

    const timer = setTimeout(() => {
      // Still nothing. Say so, rather than leaving a control that cannot be used
      // and does not explain itself. A late `onLoad` still recovers it.
      setSdkStatus((current) => (current === 'loading' ? 'unavailable' : current));
    }, SDK_READY_TIMEOUT_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [initialiseSdk]);

  const onSdkLoad = useCallback((): void => {
    if (!initialiseSdk()) {
      // The script reported itself loaded and left no `FB` behind — a truncated
      // response, or something serving a different body from that URL.
      setSdkStatus('unavailable');
    }
  }, [initialiseSdk]);

  const onSdkError = useCallback((): void => {
    setSdkStatus('unavailable');
  }, []);

  const start = useCallback((): void => {
    const sdk = window.FB;

    if (sdk === undefined || webEnv.metaEmbeddedSignupConfigId === null) {
      setSdkStatus('unavailable');
      setState({ status: 'failed', report: connectFailure('sdk_unavailable') });
      return;
    }

    // A fresh attempt, so a stale half from an abandoned run cannot combine with
    // a fresh one.
    attemptRef.current = freshAttempt();
    setState({ status: 'authorising' });

    // The run needs two messages and can only ever receive one of them. Meta
    // posting from a host this build does not trust, renaming the event, or a
    // privacy extension eating the post all leave the flow waiting for a half
    // that is not coming — and every one of those is silent by design, because
    // an unrecognised message must not end a run that is still going. This is
    // what makes "still going" a claim with an expiry date.
    clearAttemptTimer();
    attemptTimerRef.current = setTimeout(() => {
      attemptTimerRef.current = null;
      fail(connectFailure('timed_out'));
    }, ATTEMPT_TIMEOUT_MS);

    sdk.login((response) => {
      const code = response.authResponse?.code;

      if (code === undefined || code === '') {
        // No authorisation: the window was closed, or the person declined. Meta
        // usually posts `CANCEL` too, and whichever arrives first settles it.
        fail(connectFailure('cancelled'));
        return;
      }

      attemptRef.current.code = code;
      submitIfReady();
    }, embeddedSignupLoginOptions(webEnv.metaEmbeddedSignupConfigId));
  }, [clearAttemptTimer, fail, submitIfReady]);

  return {
    state,
    sdkStatus,
    isConfigured: webEnv.metaAppId !== null && webEnv.metaEmbeddedSignupConfigId !== null,
    onSdkLoad,
    onSdkError,
    start,
  };
}

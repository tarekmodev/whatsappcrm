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
 */

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
  // Read inside handlers registered once; a ref keeps them from capturing a stale
  // callback without re-registering the window listener on every render.
  const onConnectedRef = useRef(onConnected);

  onConnectedRef.current = onConnected;

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const settle = useCallback((next: EmbeddedSignupState): void => {
    attemptRef.current.isSettled = true;

    if (isMountedRef.current) {
      setState(next);
    }
  }, []);

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
   * Marks the attempt settled *before* awaiting, so a `CANCEL` arriving while the
   * request is in flight — Meta closes its window after `FINISH` — cannot replace
   * a connection in progress with "you cancelled".
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

    attempt.isSettled = true;
    setState({ status: 'connecting' });

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
  }, [fail]);

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

  const onSdkLoad = useCallback((): void => {
    const sdk = window.FB;

    if (sdk === undefined || webEnv.metaAppId === null) {
      setSdkStatus('unavailable');
      return;
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
  }, []);

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
  }, [fail, submitIfReady]);

  return {
    state,
    sdkStatus,
    isConfigured: webEnv.metaAppId !== null && webEnv.metaEmbeddedSignupConfigId !== null,
    onSdkLoad,
    onSdkError,
    start,
  };
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConnectedWhatsAppBusinessAccountResponse,
  WhatsAppEmbeddedSignupConfigResponse,
  WhatsAppRegistrationFailureReason,
  WhatsAppRegistrationStatus,
} from '@whatsappcrm/contracts';
import type { StepperStatus } from '@/components/ui/Stepper';
import { findWhatsAppInboundAction, registerWhatsAppNumberAction } from './whatsapp.actions';
import { useEmbeddedSignup, type UseEmbeddedSignup } from './useEmbeddedSignup';
import {
  autoSelectedWhatsAppNumberId,
  EMPTY_WHATSAPP_WIZARD_PROGRESS,
  whatsAppWizardStatuses,
  withWhatsAppRegistration,
  type WhatsAppWizardFailure,
  type WhatsAppWizardProgress,
  type WhatsAppWizardStepId,
} from './wizard';
import {
  clearWhatsAppWizardProgress,
  readWhatsAppWizardProgress,
  writeWhatsAppWizardProgress,
} from './wizard-storage';

/**
 * The connect wizard's whole run: Embedded Signup, the number choice, the
 * registration retry and the inbound check (TAR-814).
 *
 * `useEmbeddedSignup` is composed rather than absorbed. That hook owns a race
 * this one must not go near — Meta reports a run through two channels it does
 * not order, and the authorisation it hands back is valid for about 30 seconds —
 * and folding it in here would put a step machine between the second half
 * arriving and the request going out. It stays exactly as it was; this subscribes
 * to its one outcome.
 *
 * ## Two waits, both bounded
 *
 * Registration is a single request. The inbound check is a **poll**, because the
 * thing it is waiting for happens on somebody's phone: it runs while the reader
 * watches, and it stops — found, or a deadline. A poll with no end is a settings
 * page quietly talking to the server for the rest of the session.
 */

/** How often the inbound check asks. Long enough not to hammer, short enough to feel live. */
const INBOUND_POLL_INTERVAL_MS = 4_000;

/**
 * How long one press of "check for it" keeps looking.
 *
 * A minute is about as long as anybody will watch a spinner, and the check is
 * cheap to repeat — the step offers the button again rather than deciding on the
 * reader's behalf that the message is never coming.
 */
const INBOUND_POLL_TIMEOUT_MS = 60_000;

/** A failure the step has to render, from wherever it came. */
export interface WhatsAppWizardError {
  /** The API's own authored copy, or `null` when the request never reached it. */
  readonly message: string | null;
  readonly requestId: string | null;
}

export interface WhatsAppRegistrationState {
  /** True while the request is in flight. Drives the button's own spinner. */
  readonly isPending: boolean;
  /** Meta's published reason for the last refusal, when the last attempt was refused. */
  readonly reason: WhatsAppRegistrationFailureReason | null;
  /** Where the number stands after the last answer; `null` before any. */
  readonly status: WhatsAppRegistrationStatus | null;
  /**
   * A failure that was not a refusal — the API refused the request itself, or it
   * never arrived. `message` is the API's own authored copy where there is any;
   * `null` means the request did not reach it, and the step supplies the sentence
   * from the content layer rather than this hook inventing one.
   */
  readonly error: WhatsAppWizardError | null;
}

export interface WhatsAppInboundState {
  readonly isChecking: boolean;
  /** True once a run of the check ended without finding anything. */
  readonly hasGivenUp: boolean;
  readonly error: WhatsAppWizardError | null;
}

export interface UseWhatsAppWizard {
  readonly progress: WhatsAppWizardProgress;
  readonly statuses: Record<WhatsAppWizardStepId, StepperStatus>;
  readonly failure: WhatsAppWizardFailure | null;
  /**
   * True when the connection on screen came out of storage rather than out of
   * this sitting. The wizard says so: it is the last answer the API gave, not a
   * fact re-checked on arrival, and there is no read that could re-check it.
   */
  readonly isRestored: boolean;
  readonly signup: UseEmbeddedSignup;
  readonly registration: WhatsAppRegistrationState;
  readonly inbound: WhatsAppInboundState;
  readonly selectNumber: (whatsappAccountId: string) => void;
  readonly register: () => void;
  readonly checkInbound: () => void;
  /** Forgets the connection and starts the flow again from step one. */
  readonly reset: () => void;
}

export interface UseWhatsAppWizardOptions {
  /**
   * Called once a connection has landed and been remembered.
   *
   * The wizard's own answer to a finished connection is visible — step one goes
   * green and the meter advances — but a marker changing colour is silent, so
   * the caller announces it. Copy and the toast region belong to the component;
   * this hook holds neither.
   */
  onConnected?: (account: ConnectedWhatsAppBusinessAccountResponse) => void;
  /**
   * Meta's app id, configuration id and Graph version, read from the API by the
   * server that rendered the page (TAR-816).
   *
   * Threaded straight through to `useEmbeddedSignup`; this hook does not read
   * it. Required rather than optional, because a wizard with no configuration is
   * a wizard whose every step can only fail — the component checks
   * `signup.isConfigured` and renders an explanation instead.
   */
  config: WhatsAppEmbeddedSignupConfigResponse;
}

export function useWhatsAppWizard({
  onConnected: onConnectedProp,
  config,
}: UseWhatsAppWizardOptions): UseWhatsAppWizard {
  /*
   * Read once, during the first render, rather than in an effect afterwards.
   *
   * That is only correct because this hook is client-only by construction: its
   * panel is loaded through `dynamic(…, { ssr: false })`, so there is no server
   * render for a restored value to disagree with. An effect would be the safe
   * form under SSR and would cost a frame of empty wizard on every reload —
   * which is the one thing a resume is supposed to avoid.
   */
  const [progress, setProgress] = useState<WhatsAppWizardProgress>(readWhatsAppWizardProgress);
  const [isRestored, setIsRestored] = useState(() => progress.account !== null);
  const [failure, setFailure] = useState<WhatsAppWizardFailure | null>(null);
  const [registration, setRegistration] = useState<WhatsAppRegistrationState>({
    isPending: false,
    reason: null,
    status: null,
    error: null,
  });
  const [inbound, setInbound] = useState<WhatsAppInboundState>({
    isChecking: false,
    hasGivenUp: false,
    error: null,
  });

  // Read inside a callback registered once; a ref keeps it from capturing a
  // stale closure without re-registering the signup flow on every render.
  const onConnectedRef = useRef(onConnectedProp);

  onConnectedRef.current = onConnectedProp;

  const isMountedRef = useRef(true);
  /** Bumped by anything that ends a poll early, so an in-flight run stands down. */
  const pollRunRef = useRef(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      pollRunRef.current += 1;

      if (pollTimerRef.current !== null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  /** Every write goes through here, so nothing can change progress without persisting it. */
  const commit = useCallback(
    (next: (current: WhatsAppWizardProgress) => WhatsAppWizardProgress): void => {
      setProgress((current) => {
        const updated = next(current);

        writeWhatsAppWizardProgress(updated);

        return updated;
      });
    },
    [],
  );

  const onConnected = useCallback(
    (account: ConnectedWhatsAppBusinessAccountResponse): void => {
      // A fresh connection replaces whatever was remembered rather than merging
      // with it: the response is the authority on what this WABA now holds, and
      // a leftover selection from a previous account would point at a number
      // that is no longer on it.
      commit(() => ({
        account,
        selectedNumberId: autoSelectedWhatsAppNumberId(account),
        hasInbound: false,
      }));
      setIsRestored(false);
      setFailure(null);
      setRegistration({ isPending: false, reason: null, status: null, error: null });
      setInbound({ isChecking: false, hasGivenUp: false, error: null });
      onConnectedRef.current?.(account);
    },
    [commit],
  );

  const signup = useEmbeddedSignup({ onConnected, config });

  /*
   * Step one's verdict is **read** from the signup state, not mirrored into
   * state of its own.
   *
   * `useEmbeddedSignup` already classifies every way a run can end — Meta's
   * window closing, the script never arriving, the exchange being refused — into
   * one report, so copying it across in an effect would add nothing but a frame
   * in which the marker and the message disagreed, plus a second place that has
   * to remember to clear it when the next run starts. Derived, the two cannot
   * come apart.
   *
   * It takes precedence over `failure` because a failed connection puts every
   * later step out of reach: there is nothing for one of them to be reporting.
   */
  const connectFailure: WhatsAppWizardFailure | null =
    signup.state.status === 'failed'
      ? { step: 'connect_account', report: signup.state.report }
      : null;
  const currentFailure = connectFailure ?? failure;

  const selectNumber = useCallback(
    (whatsappAccountId: string): void => {
      commit((current) =>
        // Changing which number the workspace sends from invalidates the proof
        // that came with the old one: an inbound seen on a different number says
        // nothing about this one.
        current.selectedNumberId === whatsappAccountId
          ? current
          : { ...current, selectedNumberId: whatsappAccountId, hasInbound: false },
      );
      setRegistration({ isPending: false, reason: null, status: null, error: null });
      setInbound({ isChecking: false, hasGivenUp: false, error: null });
    },
    [commit],
  );

  const register = useCallback((): void => {
    const whatsappAccountId = progress.selectedNumberId;

    if (whatsappAccountId === null || registration.isPending) {
      return;
    }

    setRegistration({ isPending: true, reason: null, status: null, error: null });
    setFailure((current) => (current?.step === 'register_number' ? null : current));

    void registerWhatsAppNumberAction({ whatsappAccountId })
      .then((result) => {
        if (!isMountedRef.current) {
          return;
        }

        if (result.status === 'error') {
          setRegistration({
            isPending: false,
            reason: null,
            status: null,
            error: { message: result.message, requestId: result.requestId },
          });
          setFailure({ step: 'register_number' });

          return;
        }

        // A refusal rides in the body, not in an envelope (0002, amendment 12),
        // so this arm covers both outcomes and the reason decides the copy.
        setRegistration({
          isPending: false,
          reason: result.data.registrationFailureReason,
          status: result.data.registrationStatus,
          error: null,
        });
        commit((current) =>
          withWhatsAppRegistration(current, {
            id: result.data.whatsappAccountId,
            registrationStatus: result.data.registrationStatus,
            registrationFailureReason: result.data.registrationFailureReason,
            registeredAt: result.data.registeredAt,
            registrationAttemptedAt: result.data.registrationAttemptedAt,
          }),
        );
      })
      .catch((error: unknown) => {
        // Only reachable if the action itself could not run — a dropped network,
        // a chunk that would not load. Never swallowed.
        console.error('The WhatsApp registration request could not be sent', error);

        if (isMountedRef.current) {
          setRegistration({
            isPending: false,
            reason: null,
            status: null,
            error: { message: null, requestId: null },
          });
          setFailure({ step: 'register_number' });
        }
      });
  }, [commit, progress.selectedNumberId, registration.isPending]);

  const checkInbound = useCallback((): void => {
    const whatsappAccountId = progress.selectedNumberId;

    if (whatsappAccountId === null || inbound.isChecking) {
      return;
    }

    pollRunRef.current += 1;
    const run = pollRunRef.current;
    const deadline = Date.now() + INBOUND_POLL_TIMEOUT_MS;

    setInbound({ isChecking: true, hasGivenUp: false, error: null });
    setFailure((current) => (current?.step === 'test_send' ? null : current));

    /** One ask, then either a verdict or another ask — never a third possibility. */
    const ask = (): void => {
      void findWhatsAppInboundAction({ whatsappAccountId })
        .then((result) => {
          if (!isMountedRef.current || pollRunRef.current !== run) {
            return;
          }

          if (result.status === 'error') {
            setInbound({
              isChecking: false,
              hasGivenUp: false,
              error: { message: result.message, requestId: result.requestId },
            });
            setFailure({ step: 'test_send' });

            return;
          }

          if (result.data.hasInbound) {
            commit((current) => ({ ...current, hasInbound: true }));
            setInbound({ isChecking: false, hasGivenUp: false, error: null });

            return;
          }

          if (Date.now() >= deadline) {
            /*
             * Nothing arrived inside the window this press bought, and that is
             * **not** a failure — so the step stays `current` rather than going
             * red. Nothing is broken: a message the reader has not sent yet, or
             * one still in flight, is the ordinary reason for this, and a red
             * marker beside the number they still have to write to would be the
             * console blaming a connection that is fine.
             *
             * `hasGivenUp` is what the step reads to add a warning above the
             * instructions it keeps on screen.
             */
            setInbound({ isChecking: false, hasGivenUp: true, error: null });

            return;
          }

          pollTimerRef.current = setTimeout(ask, INBOUND_POLL_INTERVAL_MS);
        })
        .catch((error: unknown) => {
          console.error('The WhatsApp inbound check could not be sent', error);

          if (isMountedRef.current && pollRunRef.current === run) {
            setInbound({
              isChecking: false,
              hasGivenUp: false,
              error: { message: null, requestId: null },
            });
            setFailure({ step: 'test_send' });
          }
        });
    };

    ask();
  }, [commit, inbound.isChecking, progress.selectedNumberId]);

  const reset = useCallback((): void => {
    // Stops a poll that is still watching a number the wizard is about to forget.
    pollRunRef.current += 1;

    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }

    clearWhatsAppWizardProgress();
    setProgress(EMPTY_WHATSAPP_WIZARD_PROGRESS);
    setIsRestored(false);
    setFailure(null);
    setRegistration({ isPending: false, reason: null, status: null, error: null });
    setInbound({ isChecking: false, hasGivenUp: false, error: null });
  }, []);

  return {
    progress,
    statuses: whatsAppWizardStatuses(progress, currentFailure),
    failure: currentFailure,
    isRestored: isRestored && progress.account !== null,
    signup,
    registration,
    inbound,
    selectNumber,
    register,
    checkInbound,
    reset,
  };
}

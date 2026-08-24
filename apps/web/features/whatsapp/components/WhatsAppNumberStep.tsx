'use client';

import type { ConnectedWhatsAppBusinessAccountResponse } from '@whatsappcrm/contracts';
import { ErrorState } from '@/components/ui/ErrorState';
import { Field } from '@/components/ui/Field';
import { Select, type SelectOption } from '@/components/ui/Select';
import { Stack } from '@/components/layout/Stack';
import { isolateLtr } from '@/lib/locale/bidi';
import { useContent } from '@/lib/content';
import type { WhatsAppNumberProblem } from '../wizard';
import styles from './WhatsAppWizardStep.module.css';

/**
 * Step two's body: which of the account's numbers this workspace sends from.
 * Usage: `<WhatsAppNumberStep account={…} selectedNumberId={…} onSelect={…} />`.
 *
 * ## Why this is a step and not a row in a table
 *
 * A WABA may hold several numbers, and everything after this — registration, the
 * inbound check, and every reply the team sends — is about **one** of them. Left
 * implicit, a workspace registers whichever number happened to sort first and
 * finds out months later that its team has been answering from the wrong one.
 *
 * A single-number account never sees this: it is chosen on arrival, because
 * offering a choice of one is a question with no answer to give.
 *
 * ## A native `<select>`, not a radio group
 *
 * The choice is one from a short list with a settled default, which is exactly
 * what `Select` is for — and it brings the platform picker on a phone, where an
 * admin finishing a connection on the move actually is. A radio group would be
 * right if the options needed more than a line each; these are a number and a
 * verified name.
 */
export function WhatsAppNumberStep({
  account,
  selectedNumberId,
  problem,
  onSelect,
  onReconnect,
}: {
  account: ConnectedWhatsAppBusinessAccountResponse;
  selectedNumberId: string | null;
  problem: WhatsAppNumberProblem | null;
  onSelect: (whatsappAccountId: string) => void;
  /** Sends the reader back through Embedded Signup, which is the only way out. */
  onReconnect: () => void;
}) {
  const content = useContent();
  const copy = content.whatsapp.wizard.steps.select_number;

  if (problem !== null) {
    return (
      <ErrorState
        title={problem === 'no_numbers' ? copy.noNumbersHeading : copy.unusableHeading}
        description={problem === 'no_numbers' ? copy.noNumbersBody : copy.unusableBody}
        onRetry={onReconnect}
        retryLabel={content.whatsapp.wizard.startAgain}
      />
    );
  }

  return (
    <Stack gap="3">
      <p className={styles.intro}>{copy.current}</p>
      <Field label={copy.fieldLabel} hint={copy.fieldHint}>
        {({ controlId, describedBy }) => (
          <Select
            id={controlId}
            aria-describedby={describedBy}
            // The empty string is the unchosen state, and it is a real option
            // rather than a silent first row: a `<select>` that opens on a value
            // nobody picked reads as a decision already taken.
            value={selectedNumberId ?? ''}
            options={numberOptions(account, copy.fieldPlaceholder)}
            onChange={(event) => {
              if (event.target.value !== '') {
                onSelect(event.target.value);
              }
            }}
          />
        )}
      </Field>
    </Stack>
  );
}

/**
 * The number, then the name Meta verified for it — the two things that tell an
 * admin which of their numbers this is. Built from `content` so a locale changes
 * the placeholder without touching this component.
 *
 * `isolateLtr` on the number because an `<option>` label is a string with no
 * element to hang a `dir` on. Under `dir="rtl"` an E.164 number's leading `+`
 * has no strong character before it, so it takes the paragraph's direction and
 * renders at the trailing end — `+966501234567` as `966501234567+` — in a list
 * whose entire job is telling two of the workspace's numbers apart. The verified
 * name is left alone: it is the one part of this label that really is prose, and
 * it may itself be Arabic.
 */
function numberOptions(
  account: ConnectedWhatsAppBusinessAccountResponse,
  placeholder: string,
): readonly SelectOption[] {
  return [
    { value: '', label: placeholder },
    ...account.accounts.map((number) => ({
      value: number.id,
      label:
        number.verifiedName === null
          ? isolateLtr(number.displayPhoneNumber)
          : `${isolateLtr(number.displayPhoneNumber)} — ${number.verifiedName}`,
    })),
  ];
}

'use client';

import type { MessageTemplateHeaderFormat, UploadableMediaKind } from '@whatsappcrm/contracts';
import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { Stack } from '@/components/layout/Stack';
import { useContent } from '@/lib/content';
import type { ComposerAttachmentValue } from '@/features/inbox/media-draft';
import type { TemplateDraft, TemplateLocationDraft } from '@/features/inbox/template-draft';
import { ComposerAttachment } from './ComposerAttachment';
import { TemplateVariableFields } from './TemplateVariableFields';

/**
 * Whatever the template's approved header needs, supplied at send time. Usage:
 * `<TemplateHeaderFields format={template.headerFormat} draft={…} … />`.
 *
 * A header is not decoration and not optional: the send path requires one
 * exactly when the template publishes a `headerFormat`, refuses one when it does
 * not, and requires the two formats to agree. Without this, a template approved
 * with an IMAGE header passes the approved-only filter, renders its body inputs,
 * satisfies the arity check, and then fails at Meta for want of a picture.
 *
 * Four formats, four controls, one switch — and the two that are not bespoke
 * reuse what the composer already has: a `text` header is
 * `TemplateVariableFields`, and an image, video or document header is the same
 * `ComposerAttachment` the free-form box uses, narrowed to the one kind Meta
 * approved.
 */

export interface TemplateHeaderFieldsProps {
  /** `null` for a template with no header; this component then renders nothing. */
  format: MessageTemplateHeaderFormat | null;
  draft: TemplateDraft;
  onHeaderVariablesChange: (values: readonly string[]) => void;
  onHeaderMediaChange: (value: ComposerAttachmentValue) => void;
  onLocationChange: (location: TemplateLocationDraft) => void;
  isDisabled?: boolean;
}

export function TemplateHeaderFields({
  format,
  draft,
  onHeaderVariablesChange,
  onHeaderMediaChange,
  onLocationChange,
  isDisabled = false,
}: TemplateHeaderFieldsProps) {
  const content = useContent();

  if (format === null) {
    return null;
  }

  if (format === 'text') {
    return (
      <TemplateVariableFields
        values={draft.headerVariables}
        label={content.composer.templateHeaderVariableLabel}
        onChange={onHeaderVariablesChange}
        isDisabled={isDisabled}
      />
    );
  }

  if (format === 'location') {
    return (
      <LocationFields
        location={draft.location}
        onChange={onLocationChange}
        isDisabled={isDisabled}
      />
    );
  }

  return (
    <ComposerAttachment
      label={content.composer.templateHeaderMediaLabel(content.messageTypes[format])}
      hint={content.composer.templateHeaderMediaHint}
      // Exactly the one kind Meta approved. A PDF offered to an IMAGE header is
      // refused here rather than at Meta, where the error names neither the
      // template nor the upload.
      allowedKinds={[format satisfies UploadableMediaKind]}
      value={draft.headerMedia}
      onChange={onHeaderMediaChange}
      isDisabled={isDisabled}
    />
  );
}

/**
 * A `location` header carries no placeholder — Meta renders the map from what is
 * supplied at send time — so the coordinates are typed rather than substituted,
 * and the two labels beneath them are the business's to add or leave out.
 *
 * `inputMode="decimal"` rather than `type="number"`: a number input's spinner is
 * meaningless for a coordinate, and on several browsers it silently discards a
 * value with a comma in it instead of saying so.
 */
function LocationFields({
  location,
  onChange,
  isDisabled,
}: {
  location: TemplateLocationDraft;
  onChange: (location: TemplateLocationDraft) => void;
  isDisabled: boolean;
}) {
  const content = useContent();

  const fields = [
    { key: 'latitude', label: content.composer.templateLatitudeLabel, isRequired: true },
    { key: 'longitude', label: content.composer.templateLongitudeLabel, isRequired: true },
    { key: 'name', label: content.composer.templatePlaceNameLabel, isRequired: false },
    { key: 'address', label: content.composer.templatePlaceAddressLabel, isRequired: false },
  ] as const satisfies readonly {
    key: keyof TemplateLocationDraft;
    label: string;
    isRequired: boolean;
  }[];

  return (
    <Stack gap="3">
      {fields.map(({ key, label, isRequired }) => (
        <Field
          key={key}
          label={label}
          isRequired={isRequired}
          hint={isRequired ? undefined : content.common.optional}
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              id={controlId}
              value={location[key]}
              disabled={isDisabled}
              inputMode={isRequired ? 'decimal' : undefined}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              onChange={(event) => {
                onChange({ ...location, [key]: event.target.value });
              }}
            />
          )}
        </Field>
      ))}
    </Stack>
  );
}

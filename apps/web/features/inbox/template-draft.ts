import {
  SEND_TEMPLATE_HEADER_LIMITS,
  type MessageTemplateResponse,
  type SendTemplateHeader,
  type SendTemplateInput,
} from '@whatsappcrm/contracts';
import { EMPTY_ATTACHMENT, type ComposerAttachmentValue } from '@/features/inbox/media-draft';

/**
 * What an agent has filled in for the template they picked, and the one function
 * that turns it into a send the API will accept.
 *
 * Pure, and separate from the form, because this is where the interesting cases
 * are. The send path refuses a template whose arity or header does not match the
 * approved one (`whatsapp_template_invalid`), and every one of those refusals
 * arrives *after* the agent has pressed Send on a message that then does not go.
 * Deciding it here means the Send button is simply not available until the draft
 * is one Meta can render, and the reason is on screen next to the field.
 *
 * It is not a second gate: the API checks all of this again, and this file's job
 * is to make sure it never has to say no.
 */

export interface TemplateLocationDraft {
  /** Held as typed, not as numbers: a half-typed "-" is a string, not `NaN`. */
  readonly latitude: string;
  readonly longitude: string;
  readonly name: string;
  readonly address: string;
}

export interface TemplateDraft {
  /** Positional BODY substitutions, exactly `parameterCount` long. */
  readonly variables: readonly string[];
  /** Positional substitutions for a `text` header, exactly `headerParameterCount` long. */
  readonly headerVariables: readonly string[];
  /**
   * The file behind an `image` / `video` / `document` header, at whatever stage
   * it has reached.
   *
   * The whole value rather than the `mediaId` off it, because the four states
   * are four different answers: an upload still running is a "wait", a failed
   * one is a "try another file", and only the absence of both is the "attach
   * something" this used to collapse them all into.
   */
  readonly headerMedia: ComposerAttachmentValue;
  readonly location: TemplateLocationDraft;
}

/**
 * Which field is still missing, or not yet ready. Mapped to copy by the form;
 * never shown raw.
 */
export type TemplateDraftProblem =
  | 'body-variables'
  | 'header-variables'
  | 'header-media'
  | 'header-media-uploading'
  | 'header-media-failed'
  | 'header-coordinates';

export type TemplateSendBuild =
  | { readonly outcome: 'ready'; readonly input: SendTemplateInput }
  | { readonly outcome: 'incomplete'; readonly problem: TemplateDraftProblem };

/** A draft sized to the template: one empty slot per placeholder it publishes. */
export function emptyTemplateDraft(template: MessageTemplateResponse): TemplateDraft {
  return {
    variables: Array.from({ length: template.parameterCount }, () => ''),
    headerVariables: Array.from({ length: template.headerParameterCount }, () => ''),
    headerMedia: EMPTY_ATTACHMENT,
    location: { latitude: '', longitude: '', name: '', address: '' },
  };
}

export function buildTemplateSend(
  template: MessageTemplateResponse,
  draft: TemplateDraft,
): TemplateSendBuild {
  const variables = draft.variables.map((value) => value.trim());

  if (variables.length !== template.parameterCount || variables.some(isBlank)) {
    return { outcome: 'incomplete', problem: 'body-variables' };
  }

  const header = buildHeader(template, draft);

  if (header.outcome === 'incomplete') {
    return header;
  }

  return {
    outcome: 'ready',
    input: {
      type: 'template',
      templateName: template.name,
      languageCode: template.language,
      variables,
      // Absent rather than `undefined`-valued: the send handler refuses a header
      // on a template that publishes none, and an explicit key would be one.
      ...(header.header === null ? {} : { header: header.header }),
    },
  };
}

type HeaderBuild =
  | { readonly outcome: 'ready'; readonly header: SendTemplateHeader | null }
  | { readonly outcome: 'incomplete'; readonly problem: TemplateDraftProblem };

function buildHeader(template: MessageTemplateResponse, draft: TemplateDraft): HeaderBuild {
  // A template with no header takes none. The send path refuses one that is
  // supplied anyway, so this is the only correct answer, not an optimisation.
  if (template.headerFormat === null) {
    return { outcome: 'ready', header: null };
  }

  if (template.headerFormat === 'text') {
    const variables = draft.headerVariables.map((value) => value.trim());

    if (variables.length !== template.headerParameterCount || variables.some(isBlank)) {
      return { outcome: 'incomplete', problem: 'header-variables' };
    }

    return { outcome: 'ready', header: { format: 'text', variables } };
  }

  if (template.headerFormat === 'location') {
    return buildLocationHeader(draft.location);
  }

  const media = draft.headerMedia;

  // Three not-yet-ready answers rather than one, because they need three
  // different things from the agent: wait, pick another, or attach one at all.
  // The free-form builder already draws this distinction; a template header
  // that told somebody to attach the file they were watching upload was the
  // same message for all three.
  if (media.status === 'uploading') {
    return { outcome: 'incomplete', problem: 'header-media-uploading' };
  }

  if (media.status === 'failed') {
    return { outcome: 'incomplete', problem: 'header-media-failed' };
  }

  if (media.status === 'empty') {
    return { outcome: 'incomplete', problem: 'header-media' };
  }

  const fileName = media.fileName.trim();

  return {
    outcome: 'ready',
    header: {
      format: template.headerFormat,
      mediaId: media.mediaId,
      // `fileName` is a `document`-only courtesy; the contract caps it at 255,
      // and a longer one is trimmed to the cap rather than refused — an agent
      // should not be blocked by the name their operating system produced.
      ...(template.headerFormat === 'document' && fileName !== ''
        ? { fileName: fileName.slice(0, FILE_NAME_MAX_LENGTH) }
        : {}),
    },
  };
}

/**
 * A `location` header carries no placeholder: Meta renders the map from what is
 * supplied at send time, and the approved template fixes nothing about it. So
 * the coordinates are required and the two labels are not.
 */
function buildLocationHeader(location: TemplateLocationDraft): HeaderBuild {
  const latitude = parseCoordinate(location.latitude, LATITUDE_LIMIT);
  const longitude = parseCoordinate(location.longitude, LONGITUDE_LIMIT);

  if (latitude === null || longitude === null) {
    return { outcome: 'incomplete', problem: 'header-coordinates' };
  }

  const name = location.name.trim();
  const address = location.address.trim();

  return {
    outcome: 'ready',
    header: {
      format: 'location',
      latitude,
      longitude,
      ...(name === '' ? {} : { name: name.slice(0, LOCATION_NAME_MAX_LENGTH) }),
      ...(address === '' ? {} : { address: address.slice(0, LOCATION_ADDRESS_MAX_LENGTH) }),
    },
  };
}

/**
 * A coordinate, or `null` for anything that is not one.
 *
 * `Number` rather than `parseFloat`, deliberately: `parseFloat('12abc')` is 12,
 * which would send a customer a map pin somebody did not mean to drop. The blank
 * check comes first because `Number('')` is `0` — a perfectly valid latitude,
 * and never the one an empty field meant.
 */
function parseCoordinate(value: string, limit: number): number | null {
  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  const parsed = Number(trimmed);

  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) {
    return null;
  }

  return parsed;
}

function isBlank(value: string): boolean {
  return value === '';
}

const {
  latitudeLimit: LATITUDE_LIMIT,
  longitudeLimit: LONGITUDE_LIMIT,
  fileNameMaxLength: FILE_NAME_MAX_LENGTH,
  locationNameMaxLength: LOCATION_NAME_MAX_LENGTH,
  locationAddressMaxLength: LOCATION_ADDRESS_MAX_LENGTH,
} = SEND_TEMPLATE_HEADER_LIMITS;

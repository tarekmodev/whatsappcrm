import type {
  AiConfigResponse,
  AiModelOption,
  KnowledgeDocumentStatus,
} from '@whatsappcrm/contracts';
import type { BadgeTone } from '@/components/ui/Badge';
import type { Content } from '@/lib/content';

/**
 * How the chatbot surface's values are shown: the tone a status badge takes, the
 * money and percentages `Intl` formats, and the model a `null` choice resolves
 * to.
 *
 * Pure functions with no React in them, so each is testable on its own and no
 * component has to hold a formatting rule.
 */

/**
 * A badge tone per indexing state.
 *
 * `pending` is `info` rather than `warning`: an entry that is still being split
 * is working as designed, and a page that flagged every fresh entry amber would
 * teach an admin to ignore amber. `failed` is `danger` because it is the one
 * state that needs somebody — the chatbot silently ignores that entry until it
 * is fixed.
 */
export const KNOWLEDGE_STATUS_TONES = {
  pending: 'info',
  indexed: 'success',
  failed: 'danger',
} as const satisfies Record<KnowledgeDocumentStatus, BadgeTone>;

/**
 * What the status filter’s empty option is worth in the URL: nothing at all.
 * `withQuery` drops an empty string, so “All statuses” leaves `?status=` off
 * the link rather than writing a parameter that says the default.
 */
export const ALL_STATUSES_VALUE = '';

/**
 * The order the status filter offers its options in.
 *
 * Most-looked-for first rather than `KNOWLEDGE_DOCUMENT_STATUSES` order: an
 * admin opening this filter is usually chasing what the chatbot can already
 * answer from, or what failed.
 */
export const KNOWLEDGE_STATUS_FILTER_ORDER = [
  'indexed',
  'pending',
  'failed',
] as const satisfies readonly KnowledgeDocumentStatus[];

/**
 * The status filter’s options, “All statuses” first.
 *
 * Labels are read from `content.chatbot.statuses` rather than retyped, so the
 * filter and the badge on the row it selects cannot drift apart. No tone or
 * colour on the options: `<option>` styling is the platform’s, and a partly
 * coloured native list looks broken — the badge in the row is where status
 * colour lives.
 */
export function knowledgeStatusFilterOptions(
  content: Content,
): Array<{ value: string; label: string }> {
  return [
    { value: ALL_STATUSES_VALUE, label: content.chatbot.filterStatusAll },
    ...KNOWLEDGE_STATUS_FILTER_ORDER.map((status) => ({
      value: status,
      label: content.chatbot.statuses[status],
    })),
  ];
}

/**
 * The model a configuration actually uses, which is not the same as the one it
 * stores: `null` means "the platform default", so a tenant that never chose is
 * not pinned to whatever was current the day their row was written.
 *
 * `undefined` when the API published no default — a state that should not
 * happen, and one the caller renders as "not set" rather than guessing.
 */
export function resolvedModel(config: AiConfigResponse): AiModelOption | undefined {
  if (config.model !== null) {
    return config.availableModels.find((option) => option.id === config.model);
  }

  return config.availableModels.find((option) => option.isDefault);
}

/**
 * A confidence threshold as a percentage.
 *
 * A percentage rather than `0.60`, because the number is a judgement an admin
 * makes — "how sure is sure enough" — and two decimal places read as a setting
 * somebody else calibrated. `Intl`, not `× 100`, so a locale that writes
 * percentages differently gets its own form.
 */
export function formatConfidence(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * A model's list price per million tokens.
 *
 * The prices come from the API, never from copy: they are list prices that
 * change, and a console quoting a hard-coded number would be telling a tenant
 * something nobody owns.
 */
export function formatModelPrice(locale: string, usdPerMillionTokens: number): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    // Whole dollars for $5, cents where a model is priced in them.
    maximumFractionDigits: 2,
  }).format(usdPerMillionTokens);
}

/** The select options for the model field, the platform default first and named as such. */
export function modelOptions(
  content: Content,
  config: AiConfigResponse,
): Array<{ value: string; label: string }> {
  const platformDefault = config.availableModels.find((option) => option.isDefault);

  return [
    {
      value: '',
      label:
        platformDefault === undefined
          ? content.chatbot.modelDefaultUnavailable
          : content.chatbot.modelDefaultOption(platformDefault.displayName),
    },
    ...config.availableModels.map((option) => ({ value: option.id, label: option.displayName })),
  ];
}

import type { ContactListQuery } from '@whatsappcrm/contracts';

/**
 * Sizes the contacts surface shares between a list, its skeleton and its reads,
 * so none of the three can disagree — a skeleton drawing ten rows for a page of
 * twenty-five is a layout shift with extra steps.
 */

export const CONTACTS_PAGE_SIZE = 25 satisfies ContactListQuery['limit'];

/**
 * Field rows the contact profile's custom-field card draws while loading.
 *
 * Three, not `CUSTOM_FIELD_LIMITS.definitionsPerTenant`: the cap is 50 and the
 * seeded workspace has two. The card is the same height per row whatever the
 * field's type, so being one out costs a row rather than a redesign.
 */
export const CONTACT_CUSTOM_FIELD_SKELETON_COUNT = 3;
